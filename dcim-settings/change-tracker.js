(function (root) {
  function createTracker() {
    let baseline = null;
    let latest = null;
    return {
      reset: function (versions) { baseline = Object.assign({}, versions); latest = Object.assign({}, versions); },
      accept: function (name, revision) { if (baseline) baseline[name] = revision; if (latest) latest[name] = revision; },
      observe: function (versions) {
        latest = versions;
        if (!baseline) { baseline = Object.assign({}, versions); return []; }
        return this.changes();
      },
      changes: function () {
        if (!baseline || !latest) return [];
        return Array.from(new Set(Object.keys(baseline).concat(Object.keys(latest)))).sort().filter(function (name) {
          return baseline[name] !== latest[name];
        }).map(function (name) {
          return { name: name, kind: !Object.prototype.hasOwnProperty.call(latest, name) ? '已删除' : !Object.prototype.hasOwnProperty.call(baseline, name) ? '新增' : '已修改' };
        });
      }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = createTracker;
  else root.createDcimChangeTracker = createTracker;
})(typeof window === 'undefined' ? this : window);
