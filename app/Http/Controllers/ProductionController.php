<?php

namespace App\Http\Controllers;

use App\Services\Accounts;
use App\Services\ApdService;
use App\Services\Permissions;
use App\Services\ProductionService;
use App\Services\Records;
use App\Request;
use App\Database as DB;
use App\Validation;

class ProductionController
{
    public function __construct(private Accounts $accounts, private ProductionService $production, private Records $records, private ApdService $apd) {}

    public function __invoke(Request $request)
    {
        try {
            $action = (string) $request->input('action');
            $read = ['ping', 'bootstrap', 'appdata', 'apd.photo.get', 'apd.photo.preview'];
            Permissions::check($request->isMethod('get') === in_array($action, $read), 'Metode HTTP tidak sesuai dengan action.');
            if ($action === 'ping') {
                DB::run('SELECT 1');
                return ['ok' => true, 'message' => 'PHP native + MySQL aktif', 'serverTime' => timestamp()];
            }
            // All state-dependent writes, including authentication changes, share one DB transaction.
            $result = DB::transaction(function () use ($request, $action) {
                if (! $request->isMethod('get')) {
                    DB::table('production_locks')->where('id', 1)->lockForUpdate()->first();
                }
                if ($action === 'login') {
                    return $this->accounts->login($request);
                }
                $user = $this->accounts->authenticate($request);
                if ($action === 'logout') {
                    DB::table('production_tokens')->where('hash', hash('sha256', $request->bearerToken() ?: (string) $request->input('token')))->delete();

                    return [];
                }

                return $this->dispatch($action, $request, $user);
            }, 3);

            return $result + ['ok' => true];
        } catch (\DomainException $e) {
            // Keep the established {ok,message} protocol used by the browser.
            return ['ok' => false, 'message' => $e->getMessage()];
        } catch (\JsonException $e) {
            return ['ok' => false, 'message' => 'Format data JSON tidak valid.'];
        }
    }

    private function data(Request $r, string $key = 'data'): array
    {
        $data = $r->input($key, []);
        if (is_string($data)) {
            $data = json_decode($data, true, 512, JSON_THROW_ON_ERROR);
        }
        Permissions::check(is_array($data), 'Data harus berupa objek atau daftar.');

        return $data;
    }

    private function batch(Request $r, int $max = 200, string $key = 'data'): array
    {
        $rows = $this->data($r, $key);
        Permissions::check(array_is_list($rows) && count($rows) > 0 && count($rows) <= $max, "Jumlah data harus 1–$max baris.");

        return $rows;
    }

    private function settings(): array
    {
        return $this->records->get('settings', 'kpi') ?? ['kpiFillingOutputTargetMonthly' => 150000, 'kpiPressOutputTargetMonthly' => 70000];
    }

    private function appdata(array $user): array
    {
        $can = fn ($s) => Permissions::can($user, $s);
        $dashboard = $can('dashboard');
        $kpi = $can('kpiFilling') || $can('kpiPress') || $can('kpiSpv');
        $reports = $can('workReport') || $kpi;
        $all = $this->production->entries();
        $same = $dashboard && $reports;

        return [
            'user' => $user, 'master' => $this->production->master(), 'settings' => $this->settings(),
            'entries' => array_values(array_filter($all, fn ($e) => $dashboard || $can($e['tab']))),
            'reportEntries' => $reports && ! $same ? $all : [], 'reportEntriesSameAsEntries' => $same,
            'adjustments' => $can('press') ? $this->records->all('adjustment') : [],
            'remainders' => $can('press') ? $this->production->model()['remainders'] : [],
            'spkEntries' => $dashboard || $can('spk') || $can('filling') || $can('press') || $can('spkReport') ? $this->records->all('spk') : [],
            'apdEntries' => $dashboard || $can('apd') || $kpi ? $this->records->all('apd') : [],
            'downtimeEntries' => $dashboard || $can('filling') || $kpi ? $this->records->all('downtime') : [],
            'users' => $user['role'] === 'superuser' ? $this->accounts->all() : [],
        ];
    }

    private function dispatch(string $action, Request $r, array $user): array
    {
        switch ($action) {
            case 'bootstrap': return ['user' => $user, 'master' => $this->production->master(), 'settings' => $this->settings()];
            case 'appdata': return $this->appdata($user);
            case 'entry.create':
            case 'entry.update':
                $entry = $this->production->saveEntry($user, $this->data($r), $action === 'entry.update' ? (string) $r->input('id') : null);

                return ['entry' => $entry, 'remainders' => $this->production->model()['remainders']];
            case 'entry.batchCreate':
                $saved = $duplicates = [];
                foreach ($this->batch($r) as $row) {
                    Permissions::check(is_array($row), 'Baris pengerjaan tidak valid.');
                    if ($this->records->get('entry', $row['clientRequestId'] ?? '')) {
                        $duplicates[] = $row['clientRequestId'];
                    }
                    $saved[] = $this->production->saveEntry($user, $row);
                }

                return ['entries' => $saved, 'savedIds' => array_column($saved, 'id'), 'duplicateIds' => $duplicates, 'remainders' => $this->production->model()['remainders']];
            case 'entry.delete':
                $id = (string) $r->input('id');
                $this->production->deleteEntry($user, $id);

                return ['deletedIds' => [$id], 'remainders' => $this->production->model()['remainders']];
            case 'spk.create':
            case 'spk.update':
                return ['spk' => $this->production->saveSpk($user, $this->data($r), $action === 'spk.update' ? (string) $r->input('batchNo') : null)];
            case 'spk.batchCreate':
                $saved = [];
                foreach ($this->batch($r, 99) as $row) {
                    Permissions::check(is_array($row), 'Baris SPK tidak valid.');
                    $saved[] = $this->production->saveSpk($user, $row);
                }

                return ['saved' => $saved];
            case 'spk.delete':
                $batch = (string) $r->input('batchNo');
                $this->production->deleteSpk($user, $batch);

                return ['deletedBatchNo' => $batch];
            case 'spk.batchDelete':
                $batches = array_unique($this->batch($r, 100, 'batchNos'));
                foreach ($batches as $batch) {
                    $this->production->deleteSpk($user, (string) $batch);
                }

                return ['deletedBatchNos' => array_values($batches)];
            case 'press.adjustment.close':
                $a = $this->production->closePress($user, $this->data($r));

                return ['adjustment' => $a, 'remainders' => $this->production->model()['remainders']];
            case 'press.adjustment.closeBatch':
                $saved = [];
                $payload = $this->data($r);
                $rows = $payload['rows'] ?? [];
                Permissions::check(is_array($rows) && array_is_list($rows) && count($rows) > 0 && count($rows) <= 100, 'Pilih 1–100 sisa Press.');
                foreach ($rows as $row) {
                    Permissions::check(is_array($row), 'Baris penutupan tidak valid.');
                    Permissions::check(! empty($row['targetTanggalAsal']), 'Setiap sisa Press harus memiliki Tanggal Asal.');
                    $row['alasan'] = $payload['alasan'] ?? '';
                    $saved[] = $this->production->closePress($user, $row);
                }

                return ['adjustments' => $saved, 'remainders' => $this->production->model()['remainders']];
            case 'apd.batchCreate':
                $saved = $duplicates = [];
                $new = [];
                foreach ($this->batch($r) as $row) {
                    Permissions::check(is_array($row), 'Baris APD tidak valid.');
                    $duplicate = $this->records->get('apd', $row['clientRequestId'] ?? '');
                    $entry = $this->apd->save($user, $row);
                    $saved[] = $entry['id'];
                    if ($duplicate) {
                        $duplicates[] = $entry['id'];
                    } else {
                        $new[] = $entry;
                    }
                }

                return ['savedCount' => count($saved), 'newCount' => count($new), 'savedIds' => $saved, 'duplicateIds' => $duplicates, 'entries' => $new];
            case 'apd.update': return ['entry' => $this->apd->save($user, $this->data($r), (string) $r->input('id'))];
            case 'apd.delete':
                $this->apd->delete($user, (string) $r->input('id'));

                return ['deletedId' => $r->input('id')];
            case 'apd.photo.upload': return ['photoFileId' => $this->apd->upload($user, (string) $r->input('dataUrl'))];
            case 'apd.photo.preview': return ['dataUrl' => $this->apd->preview($user, (string) $r->input('photoFileId'))];
            case 'apd.photo.get': return ['dataUrls' => $this->apd->photos($user, (string) $r->input('id'))];
            case 'apd.photo.discard': $this->apd->discard($user, (string) $r->input('photoFileId'));

                return [];
            case 'downtime.upsert': return $this->downtime($user, $this->data($r));
            case 'master.add':
            case 'master.remove':
                Permissions::require($user, 'master');
                $this->production->masterWrite((string) $r->input('category'), trim((string) $r->input('value')), $action === 'master.remove');

                return ['master' => $this->production->master()];
            case 'settings.kpiTargets.set':
            case 'settings.kpiFilling.set':
            case 'settings.kpiPress.set':
                Permissions::require($user, 'kpiSettings');
                $settings = $this->settings();
                $changes = match ($action) {
                    'settings.kpiTargets.set' => ['kpiFillingOutputTargetMonthly' => $r->input('fillingValue'), 'kpiPressOutputTargetMonthly' => $r->input('pressValue')],
                    'settings.kpiFilling.set' => ['kpiFillingOutputTargetMonthly' => $r->input('value')],
                    default => ['kpiPressOutputTargetMonthly' => $r->input('value')],
                };
                foreach ($changes as $key => $value) {
                    Validation::check(['value' => $value], ['value' => 'required|integer|min:1|max:1000000000']);
                    $settings[$key] = (int) $value;
                }

                return ['settings' => $this->records->put('settings', 'kpi', $settings)];
            case 'user.add':
            case 'user.permissions.set':
            case 'user.password.reset':
            case 'user.remove':
                Permissions::check($user['role'] === 'superuser', 'Aksi ini hanya dapat dilakukan Super User.');
                if ($action === 'user.add') {
                    $this->accounts->add($r->only('username', 'name', 'password', 'role'));
                } else {
                    $this->accounts->change($action, mb_strtolower(trim((string) $r->input('username'))), $r, $user);
                }

                return ['users' => $this->accounts->all()];
            case 'maintenance.inputData.clear':
                Permissions::check($user['role'] === 'superuser' && $r->input('confirmation') === 'HAPUS SEMUA DATA', 'Konfirmasi penghapusan atau hak akses tidak valid.');
                $cleared = [];
                foreach (['entry', 'spk', 'apd', 'downtime', 'adjustment', 'audit'] as $kind) {
                    $count = $this->records->clear($kind);
                    $cleared[] = ['sheet' => $kind, 'rows' => $count];
                }
                DB::table('production_photos')->delete();

                return ['result' => ['clearedSheets' => $cleared, 'clearedAt' => timestamp()]];
        }
        Permissions::check(false, 'Action tidak dikenali.');
    }

    private function downtime(array $user, array $data): array
    {
        Permissions::require($user, 'filling');
        Validation::check($data, ['arrivalTimestamp' => 'required|date', 'alasan' => 'nullable|string', 'keterangan' => 'nullable|string|max:2000']);
        $arrival = (new \DateTimeImmutable($data['arrivalTimestamp']))->setTimezone(new \DateTimeZone('Asia/Jakarta'));
        $date = $arrival->format('Y-m-d');
        Permissions::check($date === date('Y-m-d'), 'Kedatangan racikan harus divalidasi pada hari ini.');
        Permissions::check(! $this->records->get('downtime', $date) || $user['role'] === 'superuser', 'Down Time tersimpan hanya dapat diubah Super User.');
        $minutes = (int) $arrival->format('H') * 60 + (int) $arrival->format('i') - 510;
        $reason = $minutes <= 0 ? 'Tepat Waktu' : ($data['alasan'] ?? '');
        $note = $minutes <= 0 ? '' : trim($data['keterangan'] ?? '');
        Permissions::check(in_array($reason, ['Tepat Waktu', 'Raw Material Belum Ready', 'Kendala Mesin', 'Menunggu QC', 'Salah Formulasi', 'Human Error', 'Lainnya']) && ! ($minutes > 0 && $reason === 'Tepat Waktu'), 'Alasan Down Time tidak valid.');
        Permissions::check($reason !== 'Lainnya' || $note !== '', 'Keterangan wajib diisi untuk alasan Lainnya.');
        $entry = $this->records->put('downtime', $date, ['productionStartTime' => '08:30', 'timestamp' => $arrival->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z'), 'tanggal' => $date, 'downTime' => $minutes, 'alasan' => $reason, 'keterangan' => $note]);

        return ['entry' => $entry, 'downtimeEntries' => $this->records->all('downtime')];
    }
}
