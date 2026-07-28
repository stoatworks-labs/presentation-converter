<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Migration;

use Closure;
use OCA\PresentationConverter\Db\WatchedFolderMapper;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000100Date20260728000000 extends SimpleMigrationStep {
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
        /** @var ISchemaWrapper $schema */
        $schema = $schemaClosure();

        if ($schema->hasTable(WatchedFolderMapper::TABLE)) {
            return null;
        }

        $table = $schema->createTable(WatchedFolderMapper::TABLE);

        $table->addColumn('id', Types::BIGINT, [
            'autoincrement' => true,
            'notnull' => true,
            'length' => 20,
        ]);
        $table->addColumn('user_id', Types::STRING, [
            'notnull' => true,
            'length' => 64,
        ]);
        // Nextcloud paths are user-relative here, so 4000 is ample.
        $table->addColumn('path', Types::STRING, [
            'notnull' => true,
            'length' => 4000,
        ]);
        $table->addColumn('last_scan', Types::BIGINT, [
            'notnull' => false,
            'default' => 0,
            'length' => 20,
        ]);
        // No default: MySQL and MariaDB reject DEFAULT on TEXT columns, so a
        // default here would break the migration on the most common setup.
        $table->addColumn('last_result', Types::TEXT, [
            'notnull' => false,
        ]);

        $table->setPrimaryKey(['id']);
        $table->addIndex(['user_id'], 'pconv_folders_user');

        return $schema;
    }
}
