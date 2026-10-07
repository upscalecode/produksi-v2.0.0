<?php
namespace App;

final class Request
{
    public function __construct(private array $data, private string $method = 'POST', private string $authorization = '') {}
    public static function capture(): self
    {
        $data = $_POST;
        if (str_contains($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) {
            $data = json_decode(file_get_contents('php://input'), true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($data)) throw new \DomainException('Data JSON harus berupa objek.');
        }
        return new self($data + $_GET, $_SERVER['REQUEST_METHOD'] ?? 'GET', $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    }
    public function input(string $key, mixed $default = null): mixed { return $this->data[$key] ?? $default; }
    public function only(string ...$keys): array { return array_intersect_key($this->data, array_flip($keys)); }
    public function isMethod(string $method): bool { return strtoupper($method) === $this->method; }
    public function bearerToken(): string { return preg_match('/^Bearer\s+(\S+)$/i', $this->authorization, $m) ? $m[1] : ''; }
    public function validate(array $rules): void { Validation::check($this->data, $rules); }
}
