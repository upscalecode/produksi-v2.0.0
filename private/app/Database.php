<?php
namespace App;

use PDO;

/** MySQL access for the production tables; all values use bound parameters. */
final class Database
{
    private static ?PDO $connection = null;

    public static function connection(): PDO
    {
        if (self::$connection === null) {
            $config = require dirname(__DIR__).'/koneksi.php';
            $host = getenv('DB_HOST') ?: $config['host'];
            $port = (string) (getenv('DB_PORT') ?: $config['port']);
            $name = getenv('DB_NAME') ?: $config['name'];
            $user = getenv('DB_USER') ?: $config['user'];
            $password = getenv('DB_PASSWORD');
            if ($password === false) $password = $config['password'];
            if (!preg_match('/^[a-zA-Z0-9_]+$/', $name) || !ctype_digit($port) || str_contains($host, ';')) {
                throw new \RuntimeException('Konfigurasi MySQL tidak valid.');
            }
            self::$connection = new PDO("mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4", $user, $password, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_OBJ,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
            self::$connection->exec("SET time_zone = '+07:00'");
        }
        return self::$connection;
    }

    public static function run(string $sql, array $values = []): \PDOStatement
    {
        $statement = self::connection()->prepare($sql);
        $statement->execute(array_map(static fn($v) => is_bool($v) ? (int) $v : $v, $values));
        return $statement;
    }

    public static function table(string $table): Table { return new Table($table); }

    public static function transaction(callable $callback, int $attempts = 3): mixed
    {
        for ($i = 1; ; $i++) {
            self::connection()->beginTransaction();
            try {
                $result = $callback();
                self::connection()->commit();
                return $result;
            } catch (\Throwable $e) {
                if (self::connection()->inTransaction()) self::connection()->rollBack();
                if ($i < $attempts && $e instanceof \PDOException && in_array($e->errorInfo[1] ?? 0, [1205, 1213])) continue;
                throw $e;
            }
        }
    }
}

final class Table
{
    private array $conditions = [];
    private array $values = [];
    private string $order = '';
    private string $lock = '';
    public function __construct(private string $name) { self::identifier($name); }
    private static function identifier(string $name): string
    {
        if (!preg_match('/^[a-z_][a-z0-9_]*$/i', $name)) throw new \InvalidArgumentException('Invalid SQL identifier');
        return '`'.$name.'`';
    }
    public function where(array|string $column, mixed $operator = null, mixed $value = null): self
    {
        if (is_array($column)) { foreach ($column as $key => $item) $this->where($key, $item); return $this; }
        if (func_num_args() === 2) { $value = $operator; $operator = '='; }
        if (!in_array($operator, ['=', '>', '<', '>=', '<=', '!='], true)) throw new \InvalidArgumentException('Invalid SQL operator');
        $this->conditions[] = self::identifier($column).' '.$operator.' ?';
        $this->values[] = $value;
        return $this;
    }
    private function filter(): string { return $this->conditions ? ' WHERE '.implode(' AND ', $this->conditions) : ''; }
    public function orderBy(string $column): self { $this->order = ' ORDER BY '.self::identifier($column); return $this; }
    public function lockForUpdate(): self { $this->lock = ' FOR UPDATE'; return $this; }
    public function get(): array { return Database::run('SELECT * FROM '.self::identifier($this->name).$this->filter().$this->order.$this->lock, $this->values)->fetchAll(); }
    public function first(): ?object { return Database::run('SELECT * FROM '.self::identifier($this->name).$this->filter().$this->order.' LIMIT 1'.$this->lock, $this->values)->fetch() ?: null; }
    public function count(): int { return (int) Database::run('SELECT COUNT(*) FROM '.self::identifier($this->name).$this->filter(), $this->values)->fetchColumn(); }
    public function exists(): bool { return $this->first() !== null; }
    public function delete(): int { return Database::run('DELETE FROM '.self::identifier($this->name).$this->filter(), $this->values)->rowCount(); }
    public function insert(array $data): void
    {
        Database::run('INSERT INTO '.self::identifier($this->name).' ('.implode(',', array_map(self::identifier(...), array_keys($data))).') VALUES ('.implode(',', array_fill(0, count($data), '?')).')', array_values($data));
    }
    public function update(array $data): void
    {
        $set = array_map(fn($key) => self::identifier($key).' = ?', array_keys($data));
        Database::run('UPDATE '.self::identifier($this->name).' SET '.implode(',', $set).$this->filter(), [...array_values($data), ...$this->values]);
    }
    public function updateOrInsert(array $key, array $data): void
    {
        $all = $key + $data;
        $set = array_map(fn($column) => self::identifier($column).' = ?', array_keys($data));
        Database::run('INSERT INTO '.self::identifier($this->name).' ('.implode(',', array_map(self::identifier(...), array_keys($all))).') VALUES ('.implode(',', array_fill(0, count($all), '?')).') ON DUPLICATE KEY UPDATE '.implode(',', $set), [...array_values($all), ...array_values($data)]);
    }
}
