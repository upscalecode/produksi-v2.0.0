import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const path of ['../public_html/public/script.js']) {
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
      operatorValues: () => ['Operator A'],
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

  test(`${path}: monthly production calculates and displays Filling and Press KPI`, () => {
    const nodes = new Map();
    const el = id => {
      if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {}, hidden: true, prepend() {}, setAttribute() {} });
      return nodes.get(id);
    };
    el('lap-kpi-month').value = '2026-10';
    const context = vm.createContext({
      state: { reportEntries: entries.concat([{ ...entries[0], tab: 'press', totalQty: 3500 }]), apdEntries: [], settings: {}, currentUser: { role: 'superuser' } },
      el,
      operatorValues: () => ['Operator A'],
      qs: () => null,
      qsa: () => [],
      dashboardSetText: (id, value) => { el(id).textContent = value; },
      document: { createElement: () => ({ setAttribute() {} }) },
      esc: String,
      nowIso: () => '2026-10-08T00:00:00Z',
      todayStr: () => '2026-10-08',
    });
    vm.runInContext(source.slice(source.indexOf('  function dashboardDateParts('), source.indexOf('  function dashboardDateKey(')), context);
    vm.runInContext(source.slice(source.indexOf('  function dashboardDateInPeriod('), source.indexOf('  function renderDashboardPressKpiLegacy(')), context);
    vm.runInContext(source.slice(source.indexOf('  const KPI_VARIANT_DAILY_TARGETS'), source.indexOf('  function buildKpiLaporanPrintHtml(')), context);
    for (const type of ['filling', 'press']) {
      el('lap-kpi-type').value = type;
      const data = context.collectKpiLaporanData();
      assert.equal(data.reports.length, 1);
      assert.equal(data.reports[0].operator, 'Operator A');
      assert.equal(context.showKpiLaporan(data.reports, data.period, '', false, type), true);
      assert.equal(el('lap-kpi-result').hidden, false);
      assert.match(el('lap-kpi-cards').innerHTML, /Operator A/);
    }
  });
}
