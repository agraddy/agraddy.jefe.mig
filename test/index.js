var test = require('tape');

var mod = require('../');

test('overall', function(t) {
	t.equal(mod.main('result'), 'result');
	t.end();
});


