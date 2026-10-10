<?php

namespace App\Services;


class Permissions
{
    public const SCOPES = [
        'dashboard' => 'accessDashboard', 'spk' => 'accessSpk', 'filling' => 'accessFilling',
        'press' => 'accessPress', 'apd' => 'accessApd', 'reports' => 'accessReports',
        'workReport' => 'accessWorkReport', 'spkReport' => 'accessSpkReport',
        'kpiFilling' => 'accessKpiFillingReport', 'kpiPress' => 'accessKpiPressReport',
        'kpiShift' => 'accessKpiShiftReport', 'kpiSpv' => 'accessKpiSpvReport', 'master' => 'accessMaster', 'kpiSettings' => 'accessKpiSettings',
    ];

    public const CHILDREN = ['workReport', 'spkReport', 'kpiFilling', 'kpiPress', 'kpiShift', 'kpiSpv'];

    public static function normalize(string $role, array $raw = []): array
    {
        $super = $role === 'superuser';
        // Preserve the combined flags used by older exported accounts.
        $fallbacks = ['accessWorkReport' => 'accessReports', 'accessSpkReport' => 'accessReports', 'accessKpiReport' => 'accessReports', 'accessKpiFillingReport' => 'accessReports', 'accessKpiPressReport' => 'accessReports', 'accessKpiShiftReport' => 'accessKpiReport', 'accessKpiSpvReport' => 'accessKpiReport', 'accessSpk' => 'accessFilling', 'accessKpiSettings' => 'accessMaster'];
        foreach ($fallbacks as $flag => $parent) {
            if (! array_key_exists($flag, $raw) && array_key_exists($parent, $raw)) {
                $raw[$flag] = $raw[$parent] === true;
            }
        }
        $p = array_fill_keys(array_values(self::SCOPES), $super);
        $p += array_fill_keys(['accessExportFillingCsv', 'accessExportPressCsv', 'accessKpiReport', 'deleteUnpressed', 'viewAllData', 'editOthers', 'deleteOwn', 'deleteOthers'], $super);
        $p['editOwn'] = true;
        foreach (['accessSpk', 'accessFilling', 'accessPress', 'accessApd'] as $key) {
            $p[$key] = true;
        }
        foreach ($p as $key => $value) {
            if (! $super && array_key_exists($key, $raw)) {
                $p[$key] = $raw[$key] === true;
            }
        }
        $hasLevels = isset($raw['levels']) && is_array($raw['levels']);
        foreach (self::SCOPES as $scope => $flag) {
            $level = $super ? 'admin' : ($hasLevels ? ($raw['levels'][$scope] ?? 'none') : (! $p[$flag] ? 'none' : ($scope === 'apd' ? 'admin' : (in_array($scope, ['spk', 'filling', 'press', 'master', 'kpiSettings']) ? 'write' : 'read'))));
            if (! $super && ! $hasLevels) {
                $allowed = $p[$flag] || (str_starts_with($scope, 'kpi') && $p['accessKpiReport']);
                if ($scope === 'reports') {
                    $allowed = $p['accessReports'] || $p['accessWorkReport'] || $p['accessSpkReport'] || $p['accessKpiReport'] || $p['accessKpiFillingReport'] || $p['accessKpiPressReport'] || $p['accessKpiShiftReport'] || $p['accessKpiSpvReport'];
                }
                $level = ! $allowed ? 'none' : ($scope === 'reports' && $p['accessReports'] ? 'admin' : (in_array($scope, ['spk', 'filling', 'press']) && $p['viewAllData'] && $p['editOthers'] && $p['deleteOthers'] ? 'admin' : ($scope === 'apd' ? 'admin' : (in_array($scope, ['spk', 'filling', 'press', 'master', 'kpiSettings']) ? 'write' : ($p['viewAllData'] ? 'admin' : 'read')))));
            }
            $p['levels'][$scope] = in_array($level, ['none', 'read', 'write', 'admin'], true) ? $level : 'none';
            $p[$flag] = $p['levels'][$scope] !== 'none';
        }
        if ($hasLevels && ! isset($raw['levels']['reports'])) {
            $p['levels']['reports'] = count(array_filter(self::CHILDREN, fn ($s) => $p['levels'][$s] !== 'none')) ? 'read' : 'none';
        }
        foreach (self::CHILDREN as $scope) {
            $p[self::SCOPES[$scope]] = $p['levels']['reports'] === 'admin' || ($p['levels']['reports'] !== 'none' && $p['levels'][$scope] !== 'none');
        }
        $p['accessReports'] = $p['levels']['reports'] !== 'none';
        $p['accessKpiReport'] = $p['accessKpiFillingReport'] || $p['accessKpiPressReport'] || $p['accessKpiShiftReport'] || $p['accessKpiSpvReport'];
        foreach (['spk', 'filling', 'press', 'apd'] as $scope) {
            foreach (['own', 'others'] as $owner) {
                $fallback = $hasLevels ? $owner === 'own' : ($owner === 'own' ? ($p['editOwn'] || $p['deleteOwn']) : ($p['editOthers'] || $p['deleteOthers']));
                $p['management'][$scope][$owner] = $p['levels'][$scope] === 'admin' || ($p['levels'][$scope] === 'write' && ($raw['management'][$scope][$owner] ?? $fallback) === true);
            }
        }

        return $p;
    }

    public static function can(array $user, string $scope, string $minimum = 'read'): bool
    {
        if ($user['role'] === 'superuser') {
            return true;
        }
        $levels = $user['permissions']['levels'];
        if (in_array($scope, self::CHILDREN)) {
            if ($levels['reports'] === 'admin') {
                return true;
            }
            if ($levels['reports'] === 'none') {
                return false;
            }
        }
        $rank = ['none' => 0, 'read' => 1, 'write' => 2, 'admin' => 3];

        return ($rank[$levels[$scope] ?? 'none'] ?? 0) >= $rank[$minimum];
    }

    public static function require(array $user, string $scope, string $level = 'write'): void
    {
        self::check(self::can($user, $scope, $level), "Anda tidak memiliki akses $level pada bagian $scope.");
    }

    public static function manage(array $user, string $scope, string $createdBy): void
    {
        self::require($user, $scope);
        $owner = $createdBy === $user['username'] ? 'own' : 'others';
        self::check($user['role'] === 'superuser' || ($user['permissions']['management'][$scope][$owner] ?? false), 'Anda tidak memiliki akses mengelola data ini.');
    }

    public static function check(bool $condition, string $message): void
    {
        if (! $condition) {
            throw new \DomainException($message);
        }
    }
}
