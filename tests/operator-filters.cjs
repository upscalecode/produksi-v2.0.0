const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['script.js', 'public/script.js']) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('  function masterValues(');
  const end = source.indexOf('  function normalizedFuzzyText(', start);
  const state = { master: {
    operator: ['Filling A', 'Press A', 'Gudang A', 'Belum diatur', 'Press B'],
    produk: ['Produk A'],
    operatorDetails: [
      { value: 'Filling A', departemen: 'Produksi', jabatan: 'OPERATOR FILLING' },
      { value: 'Press A', departemen: ' PRODUKSI ', jabatan: ' operator press ' },
      { value: 'Gudang A', departemen: 'Gudang', jabatan: 'OPERATOR FILLING' },
      { value: 'Belum diatur', departemen: '', jabatan: '' },
      { value: 'Press B', departemen: 'Press', jabatan: 'Operator' },
    ],
  } };
  const filters = { 'lap-kpi-type': { value: 'press' }, 'lap-line': { value: 'filling' } };
  const context = vm.createContext({ state, el: id => filters[id], normalizeKpiType: value => value });
  vm.runInContext(source.slice(start, end), context);
  const input = (id, line, category = 'operator') => ({ id, dataset: { master: category }, closest: () => line ? { dataset: { line } } : null });
  const values = field => Array.from(context.masterInputValues(field));
  assert.deepEqual(values(input('', 'filling')), ['Filling A']);
  assert.deepEqual(values(input('', 'press')), ['Press A', 'Press B']);
  assert.deepEqual(values(input('dashboardPressKpiOperator')), ['Press A', 'Press B']);
  assert.deepEqual(values(input('lap-kpi-operator')), ['Press A', 'Press B']);
  assert.deepEqual(values(input('lap-operator')), ['Filling A']);
  assert.deepEqual(values(input('apdOperator')), ['Filling A', 'Press A', 'Press B']);
  assert.deepEqual(values(input('', 'press', 'produk')), ['Produk A']);
  assert.equal(context.operatorDivision(' filling a '), 'filling');
  state.master.operatorDetails.push({ value: 'Jabatan lama', departemen: 'Produksi', jabatan: 'Filling' });
  assert.equal(context.operatorDivision('Jabatan lama'), '', 'Production requires the full Operator job title');
  delete state.master.operatorDetails;
  assert.deepEqual(values(input('', 'press')), [], 'Unassigned operators cannot cross divisions');
  console.log(`${file}: operator filters passed`);
}
