<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @extends QBMapper<WatchedFolder>
 */
class WatchedFolderMapper extends QBMapper {
    public const TABLE = 'pconv_folders';

    public function __construct(IDBConnection $db) {
        parent::__construct($db, self::TABLE, WatchedFolder::class);
    }

    /** @return WatchedFolder[] */
    public function findForUser(string $userId): array {
        $query = $this->db->getQueryBuilder();
        $query->select('*')
            ->from($this->getTableName())
            ->where($query->expr()->eq('user_id', $query->createNamedParameter($userId)))
            ->orderBy('path', 'ASC');

        return $this->findEntities($query);
    }

    public function find(int $id, string $userId): WatchedFolder {
        $query = $this->db->getQueryBuilder();
        $query->select('*')
            ->from($this->getTableName())
            ->where($query->expr()->eq('id', $query->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
            ->andWhere($query->expr()->eq('user_id', $query->createNamedParameter($userId)));

        return $this->findEntity($query);
    }

    /** Every registered folder, for the background job. @return WatchedFolder[] */
    public function findAll(): array {
        $query = $this->db->getQueryBuilder();
        $query->select('*')->from($this->getTableName())->orderBy('last_scan', 'ASC');

        return $this->findEntities($query);
    }

    /** True when this user already registered this exact path. */
    public function exists(string $userId, string $path): bool {
        $query = $this->db->getQueryBuilder();
        $query->select('id')
            ->from($this->getTableName())
            ->where($query->expr()->eq('user_id', $query->createNamedParameter($userId)))
            ->andWhere($query->expr()->eq('path', $query->createNamedParameter($path)))
            ->setMaxResults(1);

        $result = $query->executeQuery();
        $row = $result->fetch();
        $result->closeCursor();

        return $row !== false;
    }
}
