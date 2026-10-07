<?php

namespace App\Services;

use App\Request;
use App\Database as DB;
use App\Validation;

class Accounts
{
    public function publicUser(object $row): array
    {
        return ['username' => $row->username, 'name' => $row->name, 'role' => $row->role, 'active' => (bool) $row->active,
            'permissions' => Permissions::normalize($row->role, json_decode($row->permissions, true) ?: [])];
    }

    public function all(): array
    {
        return array_map($this->publicUser(...), DB::table('production_users')->orderBy('username')->get());
    }

    public function login(Request $request): array
    {
        $username = mb_strtolower(trim((string) $request->input('username')));
        $key = 'production-login:'.hash('sha256', $username);
        // Login is committed separately so failed attempts survive transaction rollback.
        $attempt = DB::table('production_login_attempts')->where('id', $key)->first();
        $count = $attempt && $attempt->expires_at > time() ? (int) $attempt->attempts : 0;
        Permissions::check($count < 5, 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.');
        $row = DB::table('production_users')->where('username', $username)->first();
        if (! $row || ! $row->active || ! password_verify((string) $request->input('password'), $row->password)) {
            DB::table('production_login_attempts')->updateOrInsert(['id' => $key], ['attempts' => $count + 1, 'expires_at' => $count ? $attempt->expires_at : time() + 900]);
            return ['ok' => false, 'message' => 'Username atau password salah.'];
        }
        DB::table('production_login_attempts')->where('id', $key)->delete();
        $token = bin2hex(random_bytes(32));
        DB::table('production_tokens')->where('expires_at', '<=', date('Y-m-d H:i:s'))->delete();
        DB::table('production_tokens')->insert(['hash' => hash('sha256', $token), 'username' => $username, 'expires_at' => date('Y-m-d H:i:s', time() + 43200)]);

        return ['token' => $token, 'user' => $this->publicUser($row)];
    }

    public function authenticate(Request $request): array
    {
        $token = $request->bearerToken() ?: (string) $request->input('token');
        $session = DB::table('production_tokens')->where('hash', hash('sha256', $token))->where('expires_at', '>', date('Y-m-d H:i:s'))->first();
        $row = $session ? DB::table('production_users')->where('username', $session->username)->where('active', true)->first() : null;
        Permissions::check((bool) $row, 'Sesi berakhir. Silakan login kembali.');

        return $this->publicUser($row);
    }

    public function add(array $data): void
    {
        $data['username'] = mb_strtolower(trim($data['username'] ?? ''));
        Validation::check($data, ['username' => 'required|regex:/^[a-z0-9_.-]+$/|max:100|unique:production_users,username', 'name' => 'required|string|max:255', 'password' => 'required|string|min:8|max:255', 'role' => 'required|in:user,superuser']);
        DB::table('production_users')->insert(['username' => $data['username'], 'name' => $data['name'], 'password' => password_hash($data['password'], PASSWORD_DEFAULT), 'role' => $data['role'], 'active' => true, 'permissions' => json_encode(Permissions::normalize($data['role'])), 'created_at' => date('Y-m-d H:i:s')]);
    }

    public function change(string $action, string $username, Request $request, array $actor): void
    {
        $row = DB::table('production_users')->where('username', $username)->first();
        Permissions::check((bool) $row, 'User tidak ditemukan.');
        if ($action === 'user.remove') {
            Permissions::check($username !== $actor['username'], 'Tidak dapat menghapus akun sendiri.');
            Permissions::check($row->role !== 'superuser' || DB::table('production_users')->where('role', 'superuser')->where('active', true)->count() > 1, 'Super User terakhir tidak dapat dihapus.');
            DB::table('production_users')->where('username', $username)->delete();
        } elseif ($action === 'user.password.reset') {
            $request->validate(['password' => 'required|string|min:8|max:255']);
            DB::table('production_users')->where('username', $username)->update(['password' => password_hash($request->input('password'), PASSWORD_DEFAULT)]);
        } else {
            $permissions = $request->input('permissions');
            if (is_string($permissions)) {
                $permissions = json_decode($permissions, true, 512, JSON_THROW_ON_ERROR);
            }
            Permissions::check(is_array($permissions), 'Hak akses tidak valid.');
            DB::table('production_users')->where('username', $username)->update(['permissions' => json_encode(Permissions::normalize($row->role, $permissions))]);
        }
        DB::table('production_tokens')->where('username', $username)->delete();
    }
}
