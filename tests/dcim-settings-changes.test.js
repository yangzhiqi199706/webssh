const assert = require('assert');
const tracker = require('../dcim-settings/change-tracker')();
tracker.reset({'a.json':'1','b.json':'2'});
assert.deepStrictEqual(tracker.observe({'a.json':'1','b.json':'2'}), []);
assert.deepStrictEqual(tracker.observe({'a.json':'3','c.json':'4'}), [
  {name:'a.json',kind:'已修改'},{name:'b.json',kind:'已删除'},{name:'c.json',kind:'新增'}
]);
tracker.accept('a.json','3');
assert.deepStrictEqual(tracker.changes().map(x=>x.name),['b.json','c.json']);
tracker.reset({'a.json':'3','c.json':'4'});
assert.deepStrictEqual(tracker.changes(),[]);
tracker.accept('a.json','saved');
assert.deepStrictEqual(tracker.observe({'a.json':'saved','c.json':'4'}),[]);
console.log('DCIM change tracker: passed');
