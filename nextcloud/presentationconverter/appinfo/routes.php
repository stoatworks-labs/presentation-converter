<?php

declare(strict_types=1);

return [
    'routes' => [
        ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

        // Folders the current user wants kept converted.
        ['name' => 'folder#index', 'url' => '/folders', 'verb' => 'GET'],
        ['name' => 'folder#create', 'url' => '/folders', 'verb' => 'POST'],
        ['name' => 'folder#destroy', 'url' => '/folders/{id}', 'verb' => 'DELETE', 'requirements' => ['id' => '\d+']],
        ['name' => 'folder#scanNow', 'url' => '/folders/{id}/scan', 'verb' => 'POST', 'requirements' => ['id' => '\d+']],

        // One-off conversion of a folder, without registering it.
        ['name' => 'folder#convertPath', 'url' => '/convert', 'verb' => 'POST'],

        ['name' => 'admin_settings#save', 'url' => '/admin/settings', 'verb' => 'POST'],
        ['name' => 'admin_settings#test', 'url' => '/admin/test', 'verb' => 'POST'],
    ],
];
