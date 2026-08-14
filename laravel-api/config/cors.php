<?php

/*
 | CORS for the Tessera API. The Next.js frontend calls this API from a different origin with
 | credentials (the tessera_session cookie), so a concrete origin is required — `*` is illegal
 | when supports_credentials is true.
 */

return [
    'paths' => ['v1/*', 'health/*'],

    'allowed_methods' => ['*'],

    'allowed_origins' => [
        env('FRONTEND_ORIGIN', 'http://localhost:3000'),
    ],

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [
        'X-Request-Id',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After',
        'ETag',
    ],

    'max_age' => 86400,

    'supports_credentials' => true,
];
