<?php

namespace App\Services;

use App\Database as DB;
use App\Validation;

class ApdService
{
    public const WEIGHTS = ['maskerTidakSesuai' => 25, 'lenganDitarik' => 20, 'sepatuDiinjak' => 10, 'rambutKelihatan' => 15, 'resletingTidakPenuh' => 10, 'memakaiAksesoris' => 20, 'kebersihanSepatu' => 10];

    public function __construct(private ProductionService $production, private Records $records) {}

    public function save(array $user, array $data, ?string $id = null): array
    {
        Permissions::require($user, 'apd');
        $old = $id ? $this->records->get('apd', $id) : null;
        if ($id) {
            Permissions::check((bool) $old, 'Data APD tidak ditemukan.');
            Permissions::manage($user, 'apd', $old['createdBy']);
        }
        Validation::check($data, ['tanggal' => 'required|date_format:Y-m-d', 'operator' => 'required|string', 'scores' => 'required|array', 'alasan' => 'nullable|string|max:15000']);
        $data['operator'] = $this->production->canonical('operator', $data['operator']);
        $this->production->assertOperatorLine($data['operator'], 'all');
        Permissions::check(count(preg_split('/\s+/', trim($data['alasan'] ?? ''), -1, PREG_SPLIT_NO_EMPTY)) <= 300, 'Alasan maksimal 300 kata.');
        $scores = [];
        $total = $weighted = 0;
        foreach (self::WEIGHTS as $key => $weight) {
            $score = $data['scores'][$key] ?? null;
            $allowed = $key === 'memakaiAksesoris' ? [0, 3] : ($key === 'kebersihanSepatu' ? [0, 2, 3] : [0, 1, 2, 3]);
            Permissions::check(is_numeric($score) && in_array((float) $score, $allowed), "Poin APD $key tidak valid.");
            $scores[$key] = (int) $score;
            $total += $score;
            $weighted += $score * $weight / 3;
        }
        $requestId = $data['clientRequestId'] ?? '';
        Permissions::check($id !== null || (bool) preg_match('/^[A-Za-z0-9-]{16,100}$/', $requestId), 'ID preview APD tidak valid.');
        if (! $id && ($existing = $this->records->get('apd', $requestId))) {
            Permissions::check($existing['createdBy'] === $user['username'], 'ID APD milik user lain.');

            return $existing;
        }
        foreach ($this->records->all('apd') as $e) {
            Permissions::check($e['id'] === $id || $e['tanggal'] !== $data['tanggal'] || mb_strtolower($e['operator']) !== mb_strtolower($data['operator']), 'Operator sudah memiliki APD pada tanggal tersebut. Gunakan Edit.');
        }
        $ids = $data['photoFileIds'] ?? $this->photoIds($data['photoFileId'] ?? '');
        Permissions::check(is_array($ids) && count($ids) <= 3 && count($ids) === count(array_unique($ids)), 'Maksimal 3 foto bukti APD yang berbeda.');
        foreach ($ids as $photoId) {
            $photo = DB::table('production_photos')->where('id', $photoId)->first();
            Permissions::check($photo && ($photo->owner === $user['username'] || in_array($photoId, $old['photoFileIds'] ?? [])), 'Foto bukti bukan milik user ini.');
        }
        $entry = ['id' => $id ?: $requestId, 'tanggal' => $data['tanggal'], 'operator' => $data['operator'], 'scores' => $scores,
            'totalPoints' => $total, 'percentage' => round($weighted / array_sum(self::WEIGHTS) * 100, 2),
            'alasan' => trim($data['alasan'] ?? ''), 'photoFileIds' => $ids,
            'photoFileId' => count($ids) > 1 ? json_encode($ids) : ($ids[0] ?? ''),
            'createdBy' => $old['createdBy'] ?? $user['username'], 'createdAt' => $old['createdAt'] ?? timestamp(), 'updatedAt' => timestamp()];

        return $this->records->put('apd', $entry['id'], $entry);
    }

    private function photoIds(string $value): array
    {
        if (! $value) {
            return [];
        }
        if (str_starts_with($value, '[')) {
            return json_decode($value, true, 512, JSON_THROW_ON_ERROR);
        }

        return [$value];
    }

    public function upload(array $user, string $dataUrl): string
    {
        Permissions::require($user, 'apd');
        Permissions::check(strlen($dataUrl) <= 7_000_000 && (bool) preg_match('#^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$#', $dataUrl, $match), 'Foto harus JPEG/PNG/WebP maksimal 5 MB.');
        $binary = base64_decode($match[2], true);
        $info = $binary === false ? false : @getimagesizefromstring($binary);
        Permissions::check($info !== false && strlen($binary) <= 5_000_000 && in_array($info['mime'], ['image/jpeg', 'image/png', 'image/webp']), 'Berkas foto tidak valid.');
        $id = uuid();
        DB::table('production_photos')->insert(['id' => $id, 'owner' => $user['username'], 'mime' => $info['mime'], 'content' => base64_encode($binary), 'created_at' => date('Y-m-d H:i:s')]);

        return $id;
    }

    public function preview(array $user, string $id, bool $attached = false): string
    {
        Permissions::require($user, 'apd', 'read');
        $photo = DB::table('production_photos')->where('id', $id)->first();
        Permissions::check($photo && ($attached || $photo->owner === $user['username']), 'Foto tidak tersedia untuk pengguna ini.');

        return 'data:'.$photo->mime.';base64,'.$photo->content;
    }

    public function photos(array $user, string $id): array
    {
        Permissions::require($user, 'apd', 'read');
        $entry = $this->records->get('apd', $id);
        Permissions::check((bool) $entry, 'Data APD tidak ditemukan.');

        return array_map(fn ($photoId) => $this->preview($user, $photoId, true), $entry['photoFileIds']);
    }

    public function discard(array $user, string $id): void
    {
        Permissions::require($user, 'apd');
        $photo = DB::table('production_photos')->where('id', $id)->first();
        if (! $photo) {
            return;
        }
        Permissions::check($photo->owner === $user['username'], 'Foto bukan milik user ini.');
        foreach ($this->records->all('apd') as $e) {
            Permissions::check(! in_array($id, $e['photoFileIds']), 'Foto sudah terhubung dengan data APD.');
        }
        DB::table('production_photos')->where('id', $id)->delete();
    }

    public function delete(array $user, string $id): void
    {
        $entry = $this->records->get('apd', $id);
        Permissions::check((bool) $entry, 'Data APD tidak ditemukan.');
        Permissions::manage($user, 'apd', $entry['createdBy']);
        $this->records->delete('apd', $id);
        foreach ($entry['photoFileIds'] as $photoId) {
            $used = count(array_filter($this->records->all('apd'), fn ($e) => in_array($photoId, $e['photoFileIds'])));
            if (! $used) {
                DB::table('production_photos')->where('id', $photoId)->delete();
            }
        }
    }
}
