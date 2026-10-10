import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const path of ['script.js', 'public/script.js']) {
  const source = fs.readFileSync(path, 'utf8');
  const context = vm.createContext({ state: {} });
  vm.runInContext(source.slice(source.indexOf('  const DEFAULT_USER_PERMISSIONS'), source.indexOf('  function selectAvailableKpiMonth(')), context);
  test(`${path}: Kashift access respects individual and parent permissions`, () => {
    const check = (levels, expected) => {
      context.state.currentUser = { role: 'user', permissions: { accessKpiReport: true, levels } };
      assert.equal(context.canKpiType('shift'), expected);
    };
    check({ reports: 'read', kpiShift: 'read' }, true);
    assert.equal(context.canOpenReports(), true);
    assert.equal(context.canKpiType('filling'), false);
    assert.equal(context.canKpiType('spv'), false);
    check({ reports: 'read', kpiFilling: 'read' }, false);
    check({ reports: 'none', kpiShift: 'read' }, false);
    check({ reports: 'admin' }, true);
    context.state.currentUser = { role: 'superuser' };
    assert.equal(context.canKpiType('shift'), true);
  });
}
