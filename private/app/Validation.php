<?php
namespace App;

/** Input checks used by production forms and snapshot imports. */
final class Validation
{
    public static function check(array $data, array $rules): void
    {
        foreach ($rules as $field => $ruleText) {
            if (str_contains($field, '.')) {
                [$parent, $child] = explode('.', $field, 2);
                if (!isset($data[$parent]) || !is_array($data[$parent])) throw new \DomainException("$parent harus berupa daftar atau objek.");
                if ($child === '*') {
                    foreach ($data[$parent] as $value) self::check(['item' => $value], ['item' => $ruleText]);
                } elseif (str_starts_with($child, '*.')) {
                    $key = substr($child, 2); $seen = [];
                    foreach ($data[$parent] as $row) {
                        if (!is_array($row)) throw new \DomainException("$parent tidak valid.");
                        self::check($row, [$key => str_replace('|distinct', '', $ruleText)]);
                        if (str_contains($ruleText, '|distinct') && in_array($row[$key], $seen, true)) throw new \DomainException("$field duplikat.");
                        $seen[] = $row[$key] ?? null;
                    }
                } else self::check($data[$parent], [$child => $ruleText]);
                continue;
            }
            $ruleset = explode('|', $ruleText);
            $exists = array_key_exists($field, $data);
            $value = $data[$field] ?? null;
            $empty = $value === null || $value === '' || $value === [];
            if (!$exists && in_array('sometimes', $ruleset)) continue;
            if ($empty && in_array('nullable', $ruleset)) continue;
            $numeric = in_array('numeric', $ruleset) || in_array('integer', $ruleset);
            $size = $numeric && is_numeric($value) ? (float) $value : (is_array($value) ? count($value) : (is_string($value) ? mb_strlen($value) : 0));
            foreach ($ruleset as $rule) {
                [$name, $arg] = array_pad(explode(':', $rule, 2), 2, '');
                if (!$exists && !in_array($name, ['required', 'present', 'required_with'])) continue;
                $valid = match ($name) {
                    'required' => !$empty,
                    'present' => $exists,
                    'required_with' => empty($data[$arg]) || !$empty,
                    'string' => is_string($value),
                    'array' => is_array($value),
                    'numeric' => is_numeric($value) && is_finite((float) $value),
                    'integer' => (is_string($value) || is_int($value) || is_float($value)) && filter_var($value, FILTER_VALIDATE_INT) !== false,
                    'min' => $size >= (float) $arg,
                    'max' => $size <= (float) $arg,
                    'gt' => is_numeric($value) && (float) $value > (float) $arg,
                    'in' => is_scalar($value) && in_array((string) $value, explode(',', $arg), true),
                    'regex' => is_string($value) && preg_match($arg, $value) === 1,
                    'date' => is_string($value) && trim($value) !== '' && strtotime($value) !== false,
                    'date_format' => is_string($value) && ($date = \DateTimeImmutable::createFromFormat('!'.$arg, $value)) && $date->format($arg) === $value,
                    'unique' => !Database::table(explode(',', $arg)[0])->where(explode(',', $arg)[1], $value)->exists(),
                    'nullable', 'sometimes' => true,
                    default => throw new \LogicException("Unknown validation rule: $name"),
                };
                if (!$valid) throw new \DomainException("Kolom $field tidak valid ($name".($arg !== '' ? ":$arg" : '').').');
            }
        }
    }
}
