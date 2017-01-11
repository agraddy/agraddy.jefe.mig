var async = require('async');
var fs = require('fs');
var path = require('path');
var mysql = require('mysql');

var output = {};

output.jefe = function(args) {
	args = args.toString().split(',');
	if(args[0] == 'init') {
		init();
	} else if(args[0] == 'up') {
		up();
	} else if(args[0] == 'down') {
		down();
	} else if(args[0] == 'create') {
		create(args.slice(1));
	} else if(args[0] == 'status') {
		status();
	} else if(args[0] == 'copy') {
		copy(args.slice(1));
	} else if(args[0] == 'test') {
		test();
	} else {
		console.log('Command not found: ' + args);
	}
}

function init() {
	console.log('init started');

	var config;
	var connection;

	async.series([
		configGet,
		migrationsCheck,
		_migrationsCheck,
		migrationsCreate,
		_migrationsCreate,
	], function(err) {
		connection.end();
		if(err) {
			console.log(err.message);
		} else {
			console.log('init completed');
		}
	});

	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	// Check if migrations directory exists
	function migrationsCheck(cb) {
		fs.stat(path.join(process.cwd(), 'migrations'), function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb();
			} else {
				cb(new Error('Migrations directory already exists.'));
			}
		});
	}

	// Check if _migrations table exists
	function _migrationsCheck(cb) {
		var query = connection.query('SELECT COUNT(*) FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb();
			} else {
				cb(new Error('The _migrations table already exists.'));
			}
		});

	}

	// Create migrations directory
	function migrationsCreate(cb) {
		fs.mkdir(path.join(process.cwd(), 'migrations'), cb);
	}

	// Create _migrations table
	function _migrationsCreate(cb) {
		var query = connection.query('CREATE TABLE ?? ( id INT(11) NOT NULL AUTO_INCREMENT, name VARCHAR(255), PRIMARY KEY(id) ) ENGINE=InnoDB DEFAULT CHARSET=utf8', ['_migrations'], function(err, rows, fields) {
			if(!err) {
				cb();
			} else {
				//console.log(err);
				cb(new Error('There was a problem creating the _migrations table.'));
			}
		});
	}
}

function up() {
	console.log('up started');

	var config;
	var connection;

	var db_migs = [];
	var file_migs = [];
	var unapplied = [];

	async.series([
		configGet,
		migrationsCheck,
		_migrationsCheck,
		migrationsGet,
		_migrationsGet,
		unappliedGet,
		ageCheck,
		migrationsApply
	], function(err) {
		connection.end();
		if(err) {
			console.log(err.message);
		} else {
			console.log('up completed');
		}
	});

	
	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	// Check if migrations directory exists
	function migrationsCheck(cb) {
		fs.stat(path.join(process.cwd(), 'migrations'), function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('Migrations directory does not exist.'));
			} else {
				cb();
			}
		});
	}

	// Check if _migrations table exists
	function _migrationsCheck(cb) {
		var query = connection.query('SELECT COUNT(*) FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('The _migrations table does not exist.'));
			} else {
				cb();
			}
		});

	}
	
	// Get migrations from directory
	function migrationsGet(cb) {
		fs.readdir(path.join(process.cwd(), 'migrations'), function(err, files) {
			if(err) {
				cb(new Error('There was a problem getting the migrations.'));
			} else {
				file_migs = files.filter(function(item) {
					// None operative files start with "_"
					return !(item[0] == '_');
				});
				cb();
			}
		});
	}

	// Get _migrations from db
	function _migrationsGet(cb) {
		//console.log('_migrationsGet');
		var query = connection.query('SELECT * FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('There was a problem getting the migrations from the database.'));
			} else {
				rows.forEach(function(item) {
					db_migs.push(item.name);
				});
				cb();
			}
		});
	}

	// Get unapplied migrations
	function unappliedGet(cb) {
		//console.log('unappliedGet');
		unapplied = file_migs.filter(function(item) {
			return db_migs.indexOf(item) == -1;
		});

		if(unapplied.length == 0) {
			cb(new Error('There are no unapplied migrations.'));
		} else {
			cb();
		}
	}

	// Check to make sure unapplied does not have any old migrations (older than the last db migration).
	function ageCheck(cb) {
		//console.log('ageCheck');
		if(db_migs.length) {
			unapplied.sort();
			db_migs.sort().reverse();

			if(unapplied[0] < db_migs[0]) {
				cb(new Error('One of the migrations is older than the last applied migration that is in the database. Migrations must be applied in order.'));
			} else {
				cb();
			}

		} else {
			cb();
		}
	}

	function migrationsApply(cb) {
		//console.log('migrationsApply');
		//console.log(unapplied);
		// List every possible command so that table names can be recognized
		var commands = ['+', '-', '>', "'"];
		var sql = '';
		async.eachSeries(unapplied, function(item, cb2) {
			var contents;
			var full;
			async.series([
				fileGet,
				upParse,
				upInsert,
				upRun
			], cb2);

			function fileGet(cb3) {
				fs.readFile(path.join(process.cwd(), 'migrations', item), function(err, data) {
					if(err) {
						cb3(new Error('There was a problem getting the contents of the migration file.'));
					} else {
						full = data.toString();
						cb3();
					}
				});
			}

			function upParse(cb3) {
				var cmd;
				var table = '';
				var table_start = false;
				var table_end = false;
				var found = {};
				var query;
				var primary_key;

				contents = full.split('=')[0].split(/\r?\n/);
				contents = contents.filter(function(item) {
					return item.length;
				});

				async.eachSeries(contents, function(line, cb4) {
					line = line.trim();

					// Subcommand: Need to figure out if table exists or not
					if(commands.indexOf(line[0]) == -1) {
						if(line[0] == '!') {
							sql += 'DROP TABLE ' + line.slice(1) + ';';
						} else {
							// Finish last table if creating a table
							if(table_start && !found[table]) {
								sql += parseTableEnd(primary_key);
							}

							table = line;
							table_start = false;
						}

						// Check if table exists
						if(typeof found[table] == 'undefined') {
							query = connection.query('SELECT COUNT(*) FROM ??', [table], function(err, rows, fields) {
								if(err) {
									// Table does not exist
									found[table] = false;
									buildTable();
								} else {
									// Table exists
									found[table] = true;
									cb4();
								}
							});
						} else {
							cb4();
						}
					} else {
						cmd = line[0];

						processTable();
					}

					function processTable() {
						if(!found[table]) {
							if(cmd != '+') {
								cb4(new Error('The table does not exist for the action being requested: ' + cmd + ' ' + table));
							} else {
								buildTable();
							}
						} else {
							processLine();
						}
					}

					function buildTable() {
						var items;
						var i;
						if(!table_start) {
							table_start = true;
							sql += 'CREATE TABLE `' + table + '` ( '; // ) for auto indenting
						} else {
							items = line.split(' ');

							sql += '`' + items[1] + '` ';
							sql += parseType(items[2]) + ' ';
							for(i = 3; i < items.length; i++) {
								sql += parseOther(items[i], (i + 1 == items.length));
								primary_key = (items[i] == 'pk') ? items[1] : primary_key;
							}

							sql += ', ';
						}
						cb4();
					}

					function processLine() {
						if(commands.indexOf(cmd) != -1) {
							sql += parseCommand(line, table);
							cb4();
						} else {
							cb4(new Error('An unrecognized command was used: ' + cmd));
						}

					}

				}, function(err) {
					// Finish last table if creating a table
					if(table_start && !found[table]) {
						sql += parseTableEnd(primary_key);
					}

					cb3(err);
				});
			}

			function upInsert(cb3) {
				query = connection.query('INSERT INTO _migrations SET name = ?', item, function(err, rows, fields) {
					console.log('Up migration started: ' + item);
					cb3(err);
				});
			}

			function upRun(cb3) {
				query = connection.query(sql, function(err, rows, fields) {
					sql = '';

					if(err) {
						console.log('Problem running migration: ' + item);
						console.log('This migration has been added to _migrations so you could try running "mig down" if you feel comfortable trying to recover.');
					} else {
						console.log('Up migration completed: ' + item);
					}
					cb3(err);
				});
			}

		}, function(err) {
			cb(err);
		});
	}

}

function down() {
	console.log('down started');

	var config;
	var connection;

	var db_migs = [];
	var file_migs = [];
	var unapplied = [];

	async.series([
		configGet,
		migrationsCheck,
		_migrationsCheck,
		migrationsGet,
		_migrationsGet,
		downCheck,
		migrationsApply
	], function(err) {
		connection.end();
		if(err) {
			console.log(err.message);
		} else {
			console.log('down completed');
		}
	});

	
	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	// Check if migrations directory exists
	function migrationsCheck(cb) {
		fs.stat(path.join(process.cwd(), 'migrations'), function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('Migrations directory does not exist.'));
			} else {
				cb();
			}
		});
	}

	// Check if _migrations table exists
	function _migrationsCheck(cb) {
		var query = connection.query('SELECT COUNT(*) FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('The _migrations table does not exist.'));
			} else {
				cb();
			}
		});

	}
	
	// Get migrations from directory
	function migrationsGet(cb) {
		fs.readdir(path.join(process.cwd(), 'migrations'), function(err, files) {
			if(err) {
				cb(new Error('There was a problem getting the migrations.'));
			} else {
				file_migs = files.filter(function(item) {
					// None operative files start with "_"
					return !(item[0] == '_');
				});
				cb();
			}
		});
	}

	// Get _migrations from db
	function _migrationsGet(cb) {
		//console.log('_migrationsGet');
		var query = connection.query('SELECT * FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('There was a problem getting the migrations from the database.'));
			} else {
				rows.forEach(function(item) {
					db_migs.push(item.name);
				});
				cb();
			}
		});
	}

	// Check to make sure unapplied does not have any old migrations (older than the last db migration).
	function downCheck(cb) {
		//console.log('downCheck');
		if(file_migs.length) {
			db_migs.sort().reverse();

			if(file_migs.indexOf(db_migs[0]) != -1) {
				unapplied.push(db_migs[0]);
				cb();
			} else {
				cb(new Error('The last applied migration does not have an associated file.'));
			}

		} else {
			cb(new Error('There are no migration files.'));
		}
	}

	function migrationsApply(cb) {
		//console.log('migrationsApply');
		// List every possible command so that table names can be recognized
		var commands = ['+', '-', '>', "'"];
		var sql = '';
		async.eachSeries(unapplied, function(item, cb2) {
			var contents;
			var full;
			async.series([
				fileGet,
				downParse,
				downRun,
				downInsert
			], cb2);

			function fileGet(cb3) {
				fs.readFile(path.join(process.cwd(), 'migrations', item), function(err, data) {
					if(err) {
						cb3(new Error('There was a problem getting the contents of the migration file.'));
					} else {
						full = data.toString();
						cb3();
					}
				});
			}

			function downParse(cb3) {
				var cmd;
				var table = '';
				var table_start = false;
				var table_end = false;
				var found = {};
				var query;
				var primary_key;

				contents = full.split('=')[1].split(/\r?\n/);
				contents = contents.filter(function(item) {
					return item.length;
				});

				async.eachSeries(contents, function(line, cb4) {
					line = line.trim();

					// Subcommand: Need to figure out if table exists or not
					if(commands.indexOf(line[0]) == -1) {
						if(line[0] == '!') {
							sql += 'DROP TABLE ' + line.slice(1) + ';';
							cb4();
						} else {
							// Finish last table if creating a table
							if(table_start && !found[table]) {
								sql += parseTableEnd(primary_key);
							}

							table = line;
							table_start = false;

							// Check if table exists
							if(typeof found[table] == 'undefined') {
								query = connection.query('SELECT COUNT(*) FROM ??', [table], function(err, rows, fields) {
									if(err) {
										// Table does not exist
										found[table] = false;
										buildTable();
									} else {
										// Table exists
										found[table] = true;
										cb4();
									}
								});
							} else {
								cb4();
							}
						}

					} else {
						cmd = line[0];

						processTable();
					}

					function processTable() {
						if(!found[table]) {
							if(cmd != '+') {
								cb4(new Error('The table does not exist for the action being requested: ' + cmd + ' ' + table));
							} else {
								buildTable();
							}
						} else {
							processLine();
						}
					}

					function buildTable() {
						var items;
						var i;
						if(!table_start) {
							table_start = true;
							sql += 'CREATE TABLE `' + table + '` ( '; // ) for auto indenting
						} else {
							items = line.split(' ');

							sql += '`' + items[1] + '` ';
							sql += parseType(items[2]) + ' ';
							for(i = 3; i < items.length; i++) {
								sql += parseOther(items[i], (i + 1 == items.length));
								primary_key = (items[i] == 'pk') ? items[1] : primary_key;
							}

							sql += ', ';
						}
						cb4();
					}

					function processLine() {
						if(commands.indexOf(cmd) != -1) {
							sql += parseCommand(line, table);
							cb4();
						} else {
							cb4(new Error('An unrecognized command was used: ' + cmd));
						}

					}

				}, function(err) {
					// Finish last table if creating a table
					if(table_start && !found[table]) {
						sql += parseTableEnd(primary_key);
					}

					cb3(err);
				});
			}

			function downRun(cb3) {
				console.log('Down migration started: ' + item);
				query = connection.query(sql, function(err, rows, fields) {
					cb3(err);
				});
			}

			function downInsert(cb3) {
				query = connection.query('DELETE FROM _migrations WHERE name = ?', item, function(err, rows, fields) {
					console.log('Down migration performed: ' + item);
					cb3(err);
				});
			}

		}, function(err) {
			cb();
		});
	}

}

function create(args) {
	console.log('create started');

	var config;
	var connection;
	var suffix = '';
	if(args.length) {
		suffix = args.join('-');
		suffix = '-' + suffix;
	}
	var filename = (new Date()).toISOString().substring(0, 19).replace('T', ' ').replace(' ', '_').replace(/:/g, '-') + suffix + '.txt';

	async.series([
			configGet,
			migrationsCheck,
			_migrationsCheck,
			migrationCreate,
			], function(err) {
				connection.end();
				if(err) {
					console.log(err.message);
				} else {
					console.log('create completed: ' + filename);
				}
			});


	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	// Check if migrations directory exists
	function migrationsCheck(cb) {
		fs.stat(path.join(process.cwd(), 'migrations'), function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('Migrations directory does not exist.'));
			} else {
				cb();
			}
		});
	}

	// Check if _migrations table exists
	function _migrationsCheck(cb) {
		var query = connection.query('SELECT COUNT(*) FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('The _migrations table does not exist.'));
			} else {
				cb();
			}
		});

	}

	// Touch a file with current date/time
	function migrationCreate(cb) {
		fs.writeFile(path.join(process.cwd(), 'migrations', filename), '', cb)
	}
}

function status() {
	console.log('status started');

	var config;
	var connection;

	var db_migs = [];
	var file_migs = [];
	var unapplied = [];

	async.series([
		configGet,
		migrationsCheck,
		_migrationsCheck,
		migrationsGet,
		_migrationsGet,
		unappliedGet,
		ageCheck,
		output
	], function(err) {
		connection.end();
		if(err) {
			console.log(err.message);
		} else {
			console.log('status completed');
		}
	});

	
	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	// Check if migrations directory exists
	function migrationsCheck(cb) {
		fs.stat(path.join(process.cwd(), 'migrations'), function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('Migrations directory does not exist.'));
			} else {
				cb();
			}
		});
	}

	// Check if _migrations table exists
	function _migrationsCheck(cb) {
		var query = connection.query('SELECT COUNT(*) FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('The _migrations table does not exist.'));
			} else {
				cb();
			}
		});

	}
	
	// Get migrations from directory
	function migrationsGet(cb) {
		fs.readdir(path.join(process.cwd(), 'migrations'), function(err, files) {
			if(err) {
				cb(new Error('There was a problem getting the migrations.'));
			} else {
				file_migs = files.filter(function(item) {
					// None operative files start with "_"
					return !(item[0] == '_');
				});
				cb();
			}
		});
	}

	// Get _migrations from db
	function _migrationsGet(cb) {
		//console.log('_migrationsGet');
		var query = connection.query('SELECT * FROM ??', ['_migrations'], function(err, rows, fields) {
			if(err) {
				cb(new Error('There was a problem getting the migrations from the database.'));
			} else {
				rows.forEach(function(item) {
					db_migs.push(item.name);
				});
				cb();
			}
		});
	}

	// Get unapplied migrations
	function unappliedGet(cb) {
		//console.log('unappliedGet');
		unapplied = file_migs.filter(function(item) {
			return db_migs.indexOf(item) == -1;
		});

		if(unapplied.length == 0) {
			cb();
		} else {
			cb();
		}
	}

	// Check to make sure unapplied does not have any old migrations (older than the last db migration).
	function ageCheck(cb) {
		//console.log('ageCheck');
		if(db_migs.length) {
			unapplied.sort();
			db_migs.sort().reverse();

			if(unapplied[0] < db_migs[0]) {
				cb(new Error('One of the migrations is older than the last applied migration that is in the database. Migrations must be applied in order.'));
			} else {
				cb();
			}

		} else {
			cb();
		}
	}

	function output(cb) {
		console.log('db: ' + config.db.database);
		console.log('last applied: ' + db_migs[0]);
		if(unapplied.length == 1) {
			console.log('unapplied: ' + unapplied.join(', '));
		} else if(unapplied.length > 1) {
			console.log('unapplied: ');
			unapplied.forEach(function(item) {
				console.log(item);
			});
		} else {
			console.log('unapplied: ' + 'none');
		}
		cb();
	}

}

function copy(args) {
	console.log('copy started');

	if(!args.length) {
		console.log(new Error('Missing module name.'));
		return;
	}

	var file_migs = [];
	var module_dir = path.join(process.cwd(), 'node_modules', args[0]);
	var module_name = args[0];
	var migrations_source_dir = path.join(process.cwd(), 'node_modules', args[0], 'migrations');
	var migrations_destination_dir = path.join(process.cwd(), 'migrations');

	var already_copied;

	async.series([
			configGet,
			moduleCheck,
			migrationsSourceCheck,
			migrationsDestinationCheck,
			copiedExistsCheck,
			copiedCheck,
			migrationsGet,
			migrationsCopy,
			copiedAppend
			], function(err) {
				connection.end();
				if(err) {
					console.log(err.message);
				} else {
					console.log('copy completed');
				}
			});


	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	function moduleCheck(cb) {
		fs.stat(module_dir, function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('The module does not appear to exist.'));
			} else {
				cb();
			}
		});
	}

	// Eventually have the migrations directory be a variable set in package.json
	function migrationsSourceCheck(cb) {
		fs.stat(migrations_source_dir, function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('There does not appear to be a migrations source directory.'));
			} else {
				cb();
			}
		});
	}

	function migrationsDestinationCheck(cb) {
		fs.stat(migrations_destination_dir, function(err, stats) {
			if(err || !stats.isDirectory()) {
				cb(new Error('There does not appear to be a migrations destination directory.'));
			} else {
				cb();
			}
		});
	}

	function copiedExistsCheck(cb) {
		fs.stat(path.join(migrations_destination_dir, '_copied.txt'), function(err, stats) {
			if(err || !stats.isFile()) {
				fs.writeFile(path.join(migrations_destination_dir, '_copied.txt'), '', cb)
			} else {
				cb();
			}
		});
	}

	function copiedCheck(cb) {
		fs.readFile(path.join(migrations_destination_dir, '_copied.txt'), function(err, data) {
			if(err) {
				cb(new Error('There was a problem getting the contents of the _copied.txt file.'));
			} else {
				already_copied = data.toString().split(/\r?\n/).filter(function(item) {
					return item.length;
				});

				if(already_copied.indexOf(module_name) != -1) {
					cb(new Error('The module is listed in the _copied.txt file which indicates the module migrations have already been copied. If you want to copy the module files again, just remove the module name from the _copied.txt file.'));
				} else {
					cb();
				}

			}
		});
	}

	function migrationsGet(cb) {
		fs.readdir(migrations_source_dir, function(err, files) {
			if(err) {
				cb(new Error('There was a problem getting the migrations.'));
			} else {
				file_migs = files;
				cb();
			}
		});
	}

	function migrationsCopy(cb) {
		file_migs.sort();
		async.eachSeries(file_migs, function(item, cb2) {
			var suffix = '-' + module_name;
			var filename = (new Date()).toISOString().substring(0, 19).replace('T', ' ').replace(' ', '_').replace(/:/g, '-') + suffix + '.txt';

			var rs = fs.createReadStream(path.join(migrations_source_dir, item));
			var ws = fs.createWriteStream(path.join(migrations_destination_dir, filename));

			ws.on('finish', function(err) {
				setTimeout(function(err) {
					cb2(err);
				}, 2000);
			});

			console.log('Copying ' + item + ' to ' + filename + '.');
			rs.pipe(ws);
		}, cb);
	}

	function copiedAppend(cb) {
		already_copied.push(module_name);

		console.log('Writing to _copied.txt file.');
		fs.writeFile(path.join(migrations_destination_dir, '_copied.txt'), already_copied.join('\n'), cb);
	}


	// Get config

	// Check if migrations directory exists

	// Check if _migrations table exists

	// Check if qip with migration exists
}


function configLoad() {
	var config = require(path.join(process.cwd(), 'config'));
	config.db.multipleStatements = true;

	return config;
}


/* EXTRA FUNCTIONS */
function parseCommand(line, table) {
	var cmd = line[0];
	var items = line.split(' ');
	var sql = '';
	if(cmd == '+') {
		sql += 'ALTER TABLE `' + table + '` ';
		sql += 'ADD ';
		sql += '`' + items[1] + '` ';
		sql += parseType(items[2]) + ' ';

		for(i = 3; i < items.length; i++) {
			sql += parseOther(items[i], (i + 1 == items.length));
		}
		sql += '; ';
	} else if(cmd == '-') {
		sql += 'ALTER TABLE `' + table + '` ';
		sql += 'DROP COLUMN ';
		sql += '`' + items[1] + '`; ';
	} else if(cmd == '>') {
		sql += 'ALTER TABLE `' + table + '` ';
		sql += 'CHANGE ';
		sql += '`' + items[1] + '` ';
		sql += '`' + items[2] + '` ';
		sql += parseType(items[3]) + ' ';

		for(i = 4; i < items.length; i++) {
			sql += parseOther(items[i], (i + 1 == items.length));
		}
		sql += '; ';
	} else if(cmd == "'") {
		sql += line.slice(1);
		sql += '; '; // Add a semicolon for good measure
	}

	return sql;
}

function parseOther(input, last) {
	if(input == 'nn') {
		return 'NOT NULL' + ' ';
	} else if(input == 'ai') {
		return 'AUTO_INCREMENT' + ' ';
	} else if(input == 'pk') {
		return '';
	} else {
		if(last) {
			return 'DEFAULT ' + input + ' ';
		} else {
			return '';
		}
	}
}

function parseTableEnd(primary_key) {
	var sql = '';
	if(primary_key) {
		sql += 'PRIMARY KEY(' + primary_key + ') ';
	} else {
		// Cut off last ", "
		sql = sql.slice(0, -2); 
	}
	sql += ') ENGINE=InnoDB DEFAULT CHARSET=utf8; ';

	return sql;
}

function parseType(input) {
	if(input == 'b') {
		return 'TINYINT(1)';
	} else if(input == 'dt') {
		return 'DATETIME';
	} else if(input == 'i') {
		return 'INT(11)';
	} else if(input == 's') {
		return 'VARCHAR(255)';
	} else if(input == 't') {
		return 'TEXT';
	}
}








function test() {
	console.log('test started');

	var connection;

	async.series([
		configGet,
		run
	], function(err) {
		connection.end();
		if(err) {
			console.log(err.message);
		} else {
			console.log('test completed');
		}
	});

	// Get config
	function configGet(cb) {
		try {
			config = configLoad();
			connection = mysql.createConnection(config.db);

			connection.connect();

			cb();
		} catch(e) {
			cb(new Error('There was a problem accessing the config file.'));
		}
	}

	function run(cb) {
		var sql = '';
		sql += 'SELECT 1; SELECT 2;';

		var query = connection.query(sql, function(err, rows, fields) {
			sql = '';
			//console.log('err');
			//console.log(err);
			cb();
		});

		console.log(query.sql);
	}
}


module.exports = output;
