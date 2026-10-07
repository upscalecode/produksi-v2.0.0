<?php

namespace App\Services;

use App\Validation;

class ProductionService
{
    public function __construct(public Records $records, public PressBalance $balance) {}

    public function master(): array
    {
        $result = ['operator' => [], 'produk' => [], 'botol' => []];
        foreach ($this->records->all('master') as $row) {
            $result[$row['category']][] = $row['value'];
        }
        $result['botolpecah'] = $result['botol'];

        return $result;
    }

    public function canonical(string $category, mixed $value): string
    {
        $value = trim((string) $value);
        foreach ($this->master()[$category] as $known) {
            if (mb_strtolower($known) === mb_strtolower($value)) {
                return $known;
            }
        }
        Permissions::check(false, "$category tidak terdaftar di Master.");
    }

    public function masterWrite(string $category, string $value, bool $remove = false): void
    {
        Validation::check(compact('category', 'value'), ['category' => 'required|in:operator,produk,botol', 'value' => 'required|string|max:200']);
        $value = trim($value);
        $id = hash('sha256', $category.'|'.mb_strtolower($value));
        if ($remove) {
            $this->records->delete('master', $id);
        } else {
            Permissions::check(! $this->records->get('master', $id), 'Data master sudah ada.');
            $this->records->put('master', $id, compact('category', 'value'));
        }
    }

    public function model(): array
    {
        return $this->balance->build($this->records->all('entry'), $this->records->all('adjustment'));
    }

    public function entries(): array
    {
        $meta = $this->model()['pressMeta'];

        return array_map(function ($e) use ($meta) {
            $e['sisaPressTanggalAsal'] = $meta[$e['id']]['tanggalAsal'] ?? '';
            $e['keterangan'] = $meta[$e['id']]['keterangan'] ?? '';

            return $e;
        }, $this->records->all('entry'));
    }

    private function auditKey(array $e): string
    {
        return $e['tab'].'|'.$e['tanggal'].'|'.(PressBalance::batch($e) ?: mb_strtolower($e['produk'].'|'.$e['botol']));
    }

    public function saveEntry(array $user, array $data, ?string $id = null): array
    {
        $old = $id ? $this->records->get('entry', $id) : null;
        if ($id) {
            Permissions::check((bool) $old, 'Data tidak ditemukan.');
            Permissions::manage($user, $old['tab'], $old['createdBy']);
        }
        Validation::check($data, [
            'line' => 'required|in:filling,press', 'tanggal' => 'required|date_format:Y-m-d',
            'batchNo' => 'required|string', 'qtyKardus' => 'required|numeric|min:0|max:100000000',
            'qtyBotolPerKardus' => 'required|numeric|min:0|max:1000000',
            'qtyBotolPecah' => 'sometimes|numeric|min:0', 'qtyKardusBasah' => 'sometimes|numeric|min:0',
        ]);
        Permissions::require($user, $data['line']);
        $requestId = $data['clientRequestId'] ?? '';
        if (! $id && preg_match('/^[A-Za-z0-9-]{16,100}$/', $requestId)) {
            $existing = $this->records->get('entry', $requestId);
            if ($existing) {
                Permissions::check($existing['createdBy'] === $user['username'], 'ID permintaan sudah digunakan user lain.');

                return $existing;
            }
        }
        $spk = $this->records->get('spk', $data['batchNo']);
        Permissions::check((bool) $spk, 'No Batch SPK tidak ditemukan.');
        foreach (['operator', 'produk', 'botol'] as $key) {
            $data[$key] = $this->canonical($key, $data[$key] ?? '');
        }
        Permissions::check($spk['produk'] === $data['produk'] && $spk['botol'] === $data['botol'], 'Produk atau Botol tidak sesuai dengan SPK.');
        if ($data['line'] === 'filling' && $spk['qtyPerDus'] > 0) {
            $data['qtyBotolPerKardus'] = $spk['qtyPerDus'];
        }
        $total = $data['qtyKardus'] * $data['qtyBotolPerKardus'];
        $before = $this->records->all('entry');
        if ($data['line'] === 'filling') {
            Permissions::check(($data['qtyKardusBasah'] ?? 0) <= $data['qtyKardus'], 'Qty Kardus Basah melebihi Qty Pengerjaan.');
            $used = array_sum(array_map(fn ($e) => $e['tab'] === 'filling' && PressBalance::batch($e) === $data['batchNo'] && $e['id'] !== $id ? $e['totalQty'] : 0, $before));
            Permissions::check($spk['qty'] <= 0 || $used + $total <= $spk['qty'], 'Qty Filling melebihi kapasitas SPK.');
        } else {
            Permissions::check($total > 0, 'Total Qty Press harus lebih dari 0.');
        }
        $entry = [
            'id' => $id ?: (preg_match('/^[A-Za-z0-9-]{16,100}$/', $requestId) ? $requestId : uuid()),
            'reportId' => ($data['line'] === 'press' ? 'PRESS - ' : 'FILL - ').$data['batchNo'],
            'tab' => $data['line'], 'tanggal' => $data['tanggal'], 'operator' => $data['operator'],
            'produk' => $data['produk'], 'botol' => $data['botol'], 'botolPecahJenis' => $data['botol'],
            'qtyKardus' => (float) $data['qtyKardus'], 'qtyBotolPerKardus' => (float) $data['qtyBotolPerKardus'],
            'totalQty' => $total, 'qtyBotolPecah' => (float) ($data['qtyBotolPecah'] ?? 0),
            'qtyKardusBasah' => $data['line'] === 'filling' ? (float) ($data['qtyKardusBasah'] ?? 0) : 0,
            'createdBy' => $old['createdBy'] ?? $user['username'], 'createdAt' => $old['createdAt'] ?? timestamp(),
            'updatedAt' => $old ? timestamp() : '',
            'updateCount' => $old ? $old['updateCount'] + 1 : max(0, (int) ($data['updateCount'] ?? 0)),
            'sisaPressTanggalAsal' => '', 'keterangan' => '',
        ];
        if (! $old) {
            foreach (array_reverse($this->records->all('audit')) as $audit) {
                if (! empty($audit['restoredEntryId']) || $audit['key'] !== $this->auditKey($entry)) {
                    continue;
                }
                $entry['updateCount'] = max($entry['updateCount'], $audit['nextUpdateCount']);
                $audit['restoredEntryId'] = $entry['id'];
                $audit['restoredAt'] = timestamp();
                $this->records->put('audit', $audit['id'], $audit);
                break;
            }
            if ($entry['updateCount'] > 0) {
                $entry['updatedAt'] = timestamp();
            }
        }
        $after = array_values(array_filter($before, fn ($e) => $e['id'] !== $id));
        $after[] = $entry;
        $this->balance->assertChange($before, $after, $this->records->all('adjustment'));
        $this->records->put('entry', $entry['id'], $entry);

        return array_values(array_filter($this->entries(), fn ($row) => $row['id'] === $entry['id']))[0];
    }

    public function deleteEntry(array $user, string $id): void
    {
        $entry = $this->records->get('entry', $id);
        Permissions::check((bool) $entry, 'Data tidak ditemukan.');
        Permissions::manage($user, $entry['tab'], $entry['createdBy']);
        $before = $this->records->all('entry');
        if ($entry['tab'] === 'filling') {
            $model = $this->model();
            foreach ($before as $other) {
                if ($other['tab'] !== 'press') {
                    continue;
                }
                Permissions::check(! in_array($id, $model['pressMeta'][$other['id']]['consumedLotIds'] ?? []) && (! PressBalance::batch($entry) || PressBalance::batch($entry) !== PressBalance::batch($other)), 'Filling sudah digunakan oleh Press. Hapus Press terkait terlebih dahulu.');
            }
        }
        $after = array_values(array_filter($before, fn ($e) => $e['id'] !== $id));
        $this->balance->assertChange($before, $after, $this->records->all('adjustment'));
        $this->records->delete('entry', $id);
        $auditId = uuid();
        $this->records->put('audit', $auditId, $entry + ['batchNo' => PressBalance::batch($entry), 'key' => $this->auditKey($entry), 'nextUpdateCount' => $entry['updateCount'] + 1, 'deletedBy' => $user['username'], 'deletedAt' => timestamp(), 'restoredEntryId' => '']);
        // Audit records have their own identity, separate from the deleted entry.
        $audit = $this->records->get('audit', $auditId);
        $audit['id'] = $auditId;
        $this->records->put('audit', $auditId, $audit);
    }

    private function assertSpkUnused(string $batch): void
    {
        foreach ($this->records->all('entry') as $e) {
            Permissions::check(PressBalance::batch($e) !== $batch, 'SPK sudah digunakan pada pengerjaan.');
        }
    }

    public function approximateMaster(array $list, string $value): string
    {
        $normalize = fn ($v) => preg_replace('/[^a-z0-9]+/', '', strtolower(iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $v)));
        $target = $normalize($value);
        if (strlen($target) < 5) {
            return '';
        }
        preg_match_all('/\d+/', $target, $numbers);
        $candidates = [];
        foreach ($list as $known) {
            $normalized = $normalize($known);
            preg_match_all('/\d+/', $normalized, $otherNumbers);
            if (! $normalized || $numbers[0] !== $otherNumbers[0]) {
                continue;
            }
            $distance = levenshtein($target, $normalized);
            $candidates[] = ['value' => $known, 'distance' => $distance, 'similarity' => 1 - $distance / max(strlen($target), strlen($normalized))];
        }
        usort($candidates, fn ($a, $b) => $a['distance'] <=> $b['distance']);
        $best = $candidates[0] ?? null;
        if (! $best || $best['distance'] > 2) {
            return '';
        }
        if (strlen($target) < 8 && ($best['distance'] > 1 || $best['similarity'] < .85)) {
            return '';
        }
        if ($best['distance'] === 2 && (strlen($target) < 15 || $best['similarity'] < .9)) {
            return '';
        }
        $second = $candidates[1] ?? null;
        if ($second && ($second['distance'] === $best['distance'] || ($best['distance'] === 2 && $second['distance'] - $best['distance'] < 2))) {
            return '';
        }

        return $best['value'];
    }

    public function saveSpk(array $user, array $data, ?string $batch = null): array
    {
        Permissions::require($user, 'spk');
        $old = $batch ? $this->records->get('spk', $batch) : null;
        if ($batch) {
            Permissions::check((bool) $old, 'SPK tidak ditemukan.');
            Permissions::manage($user, 'spk', $old['createdBy']);
        }
        Validation::check($data, ['produksiDus' => 'required|integer|min:1|max:100000000', 'qtyPerDus' => 'required|integer|min:1|max:1000000', 'status' => 'sometimes|string|max:40']);
        foreach (['produk', 'botol'] as $key) {
            if (! $old && ($data['imported'] ?? false) === true) {
                $data[$key] = $this->approximateMaster($this->master()[$key], $data[$key] ?? '') ?: trim($data[$key] ?? '');
            }
            if (! $old && ($data['imported'] ?? false) === true && ! count(array_filter($this->master()[$key], fn ($v) => mb_strtolower($v) === mb_strtolower(trim($data[$key] ?? ''))))) {
                $this->masterWrite($key, trim($data[$key] ?? ''));
            }
            $data[$key] = $this->canonical($key, $data[$key] ?? '');
        }
        if ($old && ($old['produksiDus'] != $data['produksiDus'] || $old['qtyPerDus'] != $data['qtyPerDus'])) {
            $this->assertSpkUnused($batch);
        }
        if (! $batch) {
            $today = array_filter($this->records->all('spk'), fn ($s) => $s['tanggal'] === date('Y-m-d'));
            Permissions::check(count($today) < 99, 'Maksimal 99 SPK per hari.');
            $next = 1;
            foreach ($today as $s) {
                $next = max($next, (int) substr($s['batchNo'], 0, 2) + 1);
            }
            $batch = trim($data['batchNo'] ?? '') ?: sprintf('%02d-%s', $next, date('dmY'));
            Permissions::check((bool) preg_match('/^\d{2}-\d{8}$/', $batch) && (int) substr($batch, 0, 2) > 0, 'No Batch SPK tidak valid.');
            Permissions::check(! $this->records->get('spk', $batch), 'No Batch SPK sudah tersedia.');
        }
        $spk = ['batchNo' => $batch, 'tanggal' => $old['tanggal'] ?? date('Y-m-d'),
            'produk' => $data['produk'], 'botol' => $data['botol'], 'produksiDus' => (int) $data['produksiDus'],
            'qtyPerDus' => (int) $data['qtyPerDus'], 'qty' => $data['produksiDus'] * $data['qtyPerDus'],
            'createdBy' => $old['createdBy'] ?? $user['username'], 'createdAt' => $old['createdAt'] ?? timestamp(),
            'updateCount' => $old ? $old['updateCount'] + 1 : max(0, (int) ($data['updateCount'] ?? 0)),
            'updatedAt' => $old ? timestamp() : '', 'status' => $old['status'] ?? ($data['status'] ?? 'normal')];
        $this->records->put('spk', $batch, $spk);
        if ($old) {
            foreach ($this->records->all('entry') as $e) {
                if (PressBalance::batch($e) !== $batch || ($e['produk'] === $spk['produk'] && $e['botol'] === $spk['botol'])) {
                    continue;
                }
                if (! $e['botolPecahJenis'] || $e['botolPecahJenis'] === $e['botol']) {
                    $e['botolPecahJenis'] = $spk['botol'];
                }
                $e['produk'] = $spk['produk'];
                $e['botol'] = $spk['botol'];
                $e['updatedAt'] = timestamp();
                $e['updateCount']++;
                $this->records->put('entry', $e['id'], $e);
            }
            foreach ($this->records->all('adjustment') as $a) {
                if (($a['targetBatchNo'] ?? '') !== $batch) {
                    continue;
                }
                $a['produk'] = $spk['produk'];
                $a['botol'] = $spk['botol'];
                $this->records->put('adjustment', $a['id'], $a);
            }
        }

        return $spk;
    }

    public function deleteSpk(array $user, string $batch): void
    {
        $spk = $this->records->get('spk', $batch);
        Permissions::check((bool) $spk, 'SPK tidak ditemukan.');
        Permissions::manage($user, 'spk', $spk['createdBy']);
        $this->assertSpkUnused($batch);
        $this->records->delete('spk', $batch);
    }

    public function closePress(array $user, array $data): array
    {
        Permissions::check(Permissions::can($user, 'press', 'admin') || (Permissions::can($user, 'press') && $user['permissions']['deleteUnpressed']), 'Anda tidak memiliki izin Hapus Sisa Press.');
        Validation::check($data, ['produk' => 'required|string', 'botol' => 'required|string', 'qtyBotolPerKardus' => 'required|numeric|gt:0', 'alasan' => 'required|string|min:5|max:500', 'targetTanggalAsal' => 'required_with:targetBatchNo']);
        $remaining = array_filter($this->model()['remainders'], fn ($r) => mb_strtolower($r['produk'].'|'.$r['botol']) === mb_strtolower($data['produk'].'|'.$data['botol']) && $r['qtyBotolPerKardus'] == $data['qtyBotolPerKardus'] && (empty($data['targetTanggalAsal']) || ($r['tanggalAsal'] === $data['targetTanggalAsal'] && $r['batchNo'] === ($data['targetBatchNo'] ?? ''))));
        $qty = array_sum(array_column($remaining, 'sisaQty'));
        Permissions::check($qty > 0, 'Sisa Press sudah tidak tersedia.');
        $a = ['id' => uuid(), 'tanggal' => date('Y-m-d'), 'produk' => $data['produk'], 'botol' => $data['botol'], 'qtyDitutup' => $qty, 'qtyBotolPerKardus' => (float) $data['qtyBotolPerKardus'], 'targetBatchNo' => $data['targetBatchNo'] ?? '', 'targetTanggalAsal' => $data['targetTanggalAsal'] ?? '', 'alasan' => $data['alasan'], 'closedBy' => $user['username'], 'closedByName' => $user['name'], 'createdAt' => timestamp()];
        $before = $this->model()['overflow'];
        $projected = $this->balance->build($this->records->all('entry'), [...$this->records->all('adjustment'), $a]);
        foreach ($projected['overflow'] as $id => $overflow) {
            Permissions::check($overflow <= ($before[$id] ?? 0), 'Penutupan melebihi saldo pada tanggal tersebut.');
        }

        return $this->records->put('adjustment', $a['id'], $a);
    }
}
