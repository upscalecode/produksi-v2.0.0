<?php

namespace App\Services;


class PressBalance
{
    public static function batch(array $entry): string
    {
        preg_match('/^(?:FILL|PRESS)\s*-\s*(\d{2}-\d{8})$/i', $entry['reportId'] ?? '', $match);

        return $match[1] ?? '';
    }

    private static function compare(array $a, array $b): int
    {
        return [$a['tanggal'] ?? $a['tanggalAsal'] ?? '', $a['createdAt'] ?? '', $a['id'] ?? '']
            <=> [$b['tanggal'] ?? $b['tanggalAsal'] ?? '', $b['createdAt'] ?? '', $b['id'] ?? ''];
    }

    public function build(array $entries, array $adjustments): array
    {
        $lots = [];
        $events = [];
        foreach ($entries as $e) {
            if ($e['totalQty'] <= 0) {
                continue;
            }
            if ($e['tab'] === 'filling') {
                $lots[] = [
                    'id' => $e['id'], 'batchNo' => self::batch($e), 'tanggalAsal' => $e['tanggal'],
                    'produk' => $e['produk'], 'botol' => $e['botol'], 'qtyFilling' => $e['totalQty'],
                    'qtyBotolPerKardus' => $e['qtyBotolPerKardus'], 'qtyPressTerpakai' => 0,
                    'qtyDitutup' => 0, 'remaining' => $e['totalQty'], 'createdAt' => $e['createdAt'],
                ];
            } else {
                $events[] = $e + ['type' => 'press', 'targetBatchNo' => self::batch($e), 'qty' => $e['totalQty']];
            }
        }
        foreach ($adjustments as $a) {
            if ($a['qtyDitutup'] > 0) {
                $events[] = $a + ['type' => 'closed', 'qty' => $a['qtyDitutup']];
            }
        }
        usort($lots, self::compare(...));
        usort($events, self::compare(...));
        $meta = $overflow = [];
        foreach ($events as $event) {
            $needed = $event['qty'];
            $dates = $consumed = [];
            foreach ($lots as &$lot) {
                if ($needed <= 0) {
                    break;
                }
                if ($lot['tanggalAsal'] > $event['tanggal'] || $lot['remaining'] <= 0) {
                    continue;
                }
                if (mb_strtolower($lot['produk'].'|'.$lot['botol']) !== mb_strtolower($event['produk'].'|'.$event['botol'])) {
                    continue;
                }
                $batch = $event['targetBatchNo'] ?? '';
                $per = $event['qtyBotolPerKardus'] ?? 0;
                if (! $batch && $per > 0 && $per != 1 && $lot['qtyBotolPerKardus'] != $per) {
                    continue;
                }
                if ($event['type'] === 'press' && $batch && $lot['batchNo'] !== $batch) {
                    continue;
                }
                if ($event['type'] === 'closed' && ! empty($event['targetTanggalAsal']) && ($lot['tanggalAsal'] !== $event['targetTanggalAsal'] || $lot['batchNo'] !== $batch)) {
                    continue;
                }
                $used = min($needed, $lot['remaining']);
                $lot['remaining'] -= $used;
                $needed -= $used;
                $lot[$event['type'] === 'press' ? 'qtyPressTerpakai' : 'qtyDitutup'] += $used;
                $consumed[] = $lot['id'];
                if ($lot['tanggalAsal'] < $event['tanggal']) {
                    $dates[] = $lot['tanggalAsal'];
                }
            }
            unset($lot);
            if ($event['type'] === 'press') {
                $dates = array_values(array_unique($dates));
                $meta[$event['id']] = ['tanggalAsal' => implode(', ', $dates), 'consumedLotIds' => $consumed,
                    'keterangan' => $dates ? 'Sisa tinggalan Press tanggal '.implode(', ', array_map(fn ($date) => indonesianDate($date), $dates)) : ''];
            }
            if ($needed > 0) {
                $overflow[$event['id']] = $needed;
            }
        }
        $remainders = [];
        foreach ($lots as $lot) {
            if ($lot['remaining'] <= 0) {
                continue;
            }
            $lot['sisaQty'] = $lot['remaining'];
            $lot['status'] = 'MENUNGGU PRESS';
            $lot['updatedAt'] = timestamp();
            unset($lot['remaining'], $lot['createdAt']);
            $remainders[] = $lot;
        }

        return ['remainders' => $remainders, 'pressMeta' => $meta, 'overflow' => $overflow, 'fillingLots' => $lots];
    }

    public function assertChange(array $before, array $after, array $adjustments): void
    {
        $old = $this->build($before, $adjustments)['overflow'];
        foreach ($this->build($after, $adjustments)['overflow'] as $id => $qty) {
            Permissions::check($qty <= ($old[$id] ?? 0), 'Qty Press/penutupan melebihi saldo Filling yang tersedia pada tanggal dan batch tersebut.');
        }
    }
}
