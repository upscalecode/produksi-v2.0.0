import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const path of ['../public/script.js', '../script.js']) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const assignment = source.slice(
    source.indexOf('    if (Array.isArray(data.entries)) state.entries = data.entries;'),
    source.indexOf('    if (Array.isArray(data.adjustments)) state.adjustments = data.adjustments;'),
  );
  const operators = source.slice(
    source.indexOf('  function kpiOperatorsForPeriod('),
    source.indexOf('  function shiftKpiCountedUpdates('),
  );
  const entries = [{ tab: 'filling', operator: 'Operator A', tanggal: '2026-10-08' }];
  const load = data => {
    const context = vm.createContext({
      data,
      state: { entries: [], reportEntries: [] },
      normalizeKpiType: type => type,
      dashboardDateInPeriod: () => true,
    });
    vm.runInContext(assignment + operators, context);
    return context;
  };

  test(`${path}: shared dashboard data produces KPI operators despite empty reportEntries`, () => {
    const context = load({ entries, reportEntries: [], reportEntriesSameAsEntries: true });
    assert.equal(context.state.reportEntries, entries);
    assert.deepEqual(Array.from(context.kpiOperatorsForPeriod({}, 'filling')), ['Operator A']);
  });

  test(`${path}: separate report data remains available without dashboard access`, () => {
    const context = load({ entries: [], reportEntries: entries, reportEntriesSameAsEntries: false });
    assert.equal(context.state.reportEntries, entries);
    assert.deepEqual(Array.from(context.kpiOperatorsForPeriod({}, 'filling')), ['Operator A']);
  });

  test(`${path}: explicitly empty separate report data clears previous entries`, () => {
    const context = load({ entries, reportEntries: [], reportEntriesSameAsEntries: false });
    assert.equal(context.state.reportEntries.length, 0);
  });
}
