'use strict';
/**
 * RobinRead（知更）— SQLite Schema 迁移
 *
 * 所有 Schema 变更必须通过本文件的版本迁移演进，禁止业务代码执行
 * ad-hoc 的 CREATE TABLE IF NOT EXISTS。
 */

const MIGRATIONS = [
  {
    id: 'v1-create-library-schema',
    up: (db) => {
      // 1. accounts (账号主表)
      db.exec(`
        CREATE TABLE accounts (
            id              TEXT PRIMARY KEY NOT NULL,
            type            TEXT NOT NULL,
            display_name    TEXT NOT NULL,
            endpoint_url    TEXT,
            username        TEXT,
            is_enabled      INTEGER NOT NULL DEFAULT 1,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL,

            CHECK (type IN ('local', 'freshRSS'))
        );
        CREATE INDEX idx_accounts_type ON accounts(type);
      `);

      // 2. folders (分类目录)
      db.exec(`
        CREATE TABLE folders (
            id              TEXT PRIMARY KEY NOT NULL,
            account_id      TEXT NOT NULL,
            external_id     TEXT,
            name            TEXT NOT NULL,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            is_deleted      INTEGER NOT NULL DEFAULT 0,
            updated_at      REAL NOT NULL,

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_folders_account
        ON folders(account_id, is_deleted, sort_order, name);
        CREATE UNIQUE INDEX idx_folders_remote_identity
        ON folders(account_id, external_id)
        WHERE external_id IS NOT NULL;
      `);

      // 3. feeds (订阅源)
      db.exec(`
        CREATE TABLE feeds (
            id                  TEXT PRIMARY KEY NOT NULL,
            account_id          TEXT NOT NULL,
            external_id         TEXT,
            title               TEXT NOT NULL,
            site_url            TEXT,
            feed_url            TEXT NOT NULL,
            etag                TEXT,
            last_modified       TEXT,
            last_refreshed_at   REAL,
            is_deleted          INTEGER NOT NULL DEFAULT 0,
            updated_at          REAL NOT NULL,
            stored_icon_url     TEXT,
            sort_order          INTEGER NOT NULL DEFAULT 0,

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_feeds_account
        ON feeds(account_id, is_deleted, sort_order, title);
        CREATE INDEX idx_feeds_url
        ON feeds(account_id, feed_url);
        CREATE UNIQUE INDEX idx_feeds_remote_identity
        ON feeds(account_id, external_id)
        WHERE external_id IS NOT NULL;
      `);

      // 4. feed_folders (Feed 与 Folder 多对多关联)
      db.exec(`
        CREATE TABLE feed_folders (
            feed_id     TEXT NOT NULL,
            folder_id   TEXT NOT NULL,

            PRIMARY KEY(feed_id, folder_id),

            FOREIGN KEY(feed_id)
                REFERENCES feeds(id)
                ON DELETE CASCADE,
            FOREIGN KEY(folder_id)
                REFERENCES folders(id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_feed_folders_folder
        ON feed_folders(folder_id, feed_id);
      `);

      // 5. items (文章身份层)
      db.exec(`
        CREATE TABLE items (
            id              TEXT PRIMARY KEY NOT NULL,
            account_id      TEXT NOT NULL,
            external_id     TEXT NOT NULL,
            feed_id         TEXT NOT NULL,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL,

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE,
            FOREIGN KEY(feed_id)
                REFERENCES feeds(id)
                ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_items_remote_identity
        ON items(account_id, external_id);
        CREATE INDEX idx_items_feed
        ON items(feed_id);
      `);

      // 6. articles (文章内容层)
      db.exec(`
        CREATE TABLE articles (
            item_id             TEXT PRIMARY KEY NOT NULL,
            title               TEXT NOT NULL,
            author              TEXT,
            url                 TEXT,
            published_at        REAL,
            summary             TEXT NOT NULL DEFAULT '',
            content_html        TEXT,
            content_updated_at  REAL NOT NULL,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_articles_published
        ON articles(published_at DESC);
      `);

      // 7. article_states (文章已读/标星状态层)
      db.exec(`
        CREATE TABLE article_states (
            item_id          TEXT PRIMARY KEY NOT NULL,
            is_read          INTEGER NOT NULL DEFAULT 0,
            is_starred       INTEGER NOT NULL DEFAULT 0,
            date_arrived     REAL NOT NULL,
            updated_at       REAL NOT NULL,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_article_states_unread
        ON article_states(is_read, item_id);
        CREATE INDEX idx_article_states_starred
        ON article_states(is_starred, item_id);
      `);

      // 8. article_state_outbox (待同步至远端的状态突变持久化队列)
      db.exec(`
        CREATE TABLE article_state_outbox (
            account_id          TEXT NOT NULL,
            item_id             TEXT NOT NULL,
            state_key           TEXT NOT NULL,
            desired_value       INTEGER NOT NULL,
            revision            INTEGER NOT NULL DEFAULT 1,
            updated_at          REAL NOT NULL,
            attempt_count       INTEGER NOT NULL DEFAULT 0,
            next_attempt_at     REAL,
            last_error          TEXT,

            PRIMARY KEY(account_id, item_id, state_key),

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE,
            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE,

            CHECK(state_key IN ('read', 'starred'))
        );
        CREATE INDEX idx_article_state_outbox_ready
        ON article_state_outbox(account_id, next_attempt_at, updated_at);
      `);

      // 9. article_caches (文章网页提取正文缓存)
      db.exec(`
        CREATE TABLE article_caches (
            item_id             TEXT PRIMARY KEY NOT NULL,
            text                TEXT NOT NULL,
            html                TEXT,
            image_urls_json     TEXT,
            fetched_at          REAL NOT NULL,
            source_url          TEXT,
            is_sanitized        INTEGER NOT NULL DEFAULT 0,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
      `);

      // 10. ai_artifacts (AI 摘要、全文翻译与划词解析产物)
      db.exec(`
        CREATE TABLE ai_artifacts (
            id                      TEXT PRIMARY KEY NOT NULL,
            account_id              TEXT,
            item_id                 TEXT,
            subject_key             TEXT NOT NULL,
            kind                    TEXT NOT NULL,
            content_hash            TEXT NOT NULL,
            model                   TEXT NOT NULL,
            target_language         TEXT NOT NULL,
            prompt_version          INTEGER NOT NULL DEFAULT 1,
            content                 TEXT NOT NULL DEFAULT '',
            segments_json           TEXT,
            selection_text          TEXT,
            selection_article_hash  TEXT,
            selection_anchor_json   TEXT,
            is_complete             INTEGER NOT NULL DEFAULT 0,
            is_deleted              INTEGER NOT NULL DEFAULT 0,
            created_at              REAL NOT NULL,
            updated_at              REAL NOT NULL,

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE,
            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE SET NULL
        );
        CREATE INDEX idx_ai_artifacts_article_lookup
        ON ai_artifacts(item_id, kind, content_hash, updated_at DESC);
        CREATE INDEX idx_ai_artifacts_subject_lookup
        ON ai_artifacts(subject_key, kind, content_hash, updated_at DESC);
      `);

      // 11. account_sync_state (账号同步进度与错误状态)
      db.exec(`
        CREATE TABLE account_sync_state (
            account_id                  TEXT PRIMARY KEY NOT NULL,
            initial_sync_completed      INTEGER NOT NULL DEFAULT 0,
            last_sync_started_at        REAL,
            last_sync_completed_at      REAL,
            last_full_reconcile_at      REAL,
            last_article_fetch_at       REAL,
            consecutive_failure_count   INTEGER NOT NULL DEFAULT 0,
            last_error                  TEXT,

            FOREIGN KEY(account_id)
                REFERENCES accounts(id)
                ON DELETE CASCADE
        );
      `);
    },
  },
  {
    id: 'v2-clean-local-account-sync-state',
    up: (db) => {
      db.exec(`DELETE FROM account_sync_state WHERE account_id = 'local-default';`);
    },
  },
  {
    id: 'v3-normalize-local-item-external-identity',
    up: (db) => {
      const exists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='items'"
      ).get();
      if (!exists) return;
      db.exec(`
        UPDATE items
        SET external_id = id
        WHERE account_id IN (
            SELECT id FROM accounts WHERE type = 'local'
        );
      `);
    },
  },

  {
    id: 'v4-articles-fts',
    up: (db) => {
      // FTS5 trigram 全文索引（即时全文搜索）。trigram 最小词元 3 字符，
      // 更短查询由搜索层回退 LIKE。FTS5/trigram 不可用的环境静默跳过建表，
      // SearchIndex.ftsAvailable 探测不到表即全程走 LIKE 路径。
      try {
        db.exec(`
          CREATE VIRTUAL TABLE articles_fts USING fts5(
              item_id UNINDEXED,
              title,
              author,
              summary,
              body,
              tokenize='trigram'
          );
        `);
      } catch (_) { /* FTS5 不可用：搜索保持 LIKE */ }
    },
  },

  {
    id: 'v5-explored-feeds',
    up: (db) => {
      // AI 探索（订阅源发现）：候选源的探索记录与反馈闭环
      db.exec(`
        CREATE TABLE IF NOT EXISTS explored_feeds (
            url          TEXT PRIMARY KEY NOT NULL,
            domain       TEXT,
            verdict      TEXT NOT NULL DEFAULT 'explored',
            score        REAL,
            explanation  TEXT,
            explored_at  REAL NOT NULL
        );
        CREATE INDEX idx_explored_feeds_domain ON explored_feeds(domain);
      `);
    },
  },

  {
    id: 'v6-article-is-later',
    up: (db) => {
      // 稍后读（与已读/收藏独立的第三状态）：读着累先存队列，处理完移除。
      // 本地待办状态，不参与 FreshRSS outbox 同步。
      // migrations 内无既有加列先例：ALTER TABLE ADD COLUMN 包 try/catch（列已存在时幂等跳过）。
      try {
        db.exec('ALTER TABLE article_states ADD COLUMN is_later INTEGER NOT NULL DEFAULT 0;');
      } catch (_) { /* 列已存在：幂等重入 */ }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_article_states_later
        ON article_states(is_later, item_id);
      `);
    },
  },

  {
    id: 'v7-pruned-articles',
    up: (db) => {
      // 存储治理「墓碑」：按保留期限淘汰已读历史文章时记录被删身份，
      // 防止源站刷新把老文章重新灌回来变成未读（上游 v1.4.0 同款机制）。
      // item_id 与 items 主键同构（local:<feedID>:<digest> / gr:<account>:<digest>），故可作主键。
      db.exec(`
        CREATE TABLE IF NOT EXISTS pruned_articles (
            item_id   TEXT PRIMARY KEY NOT NULL,
            feed_id   TEXT NOT NULL,
            pruned_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pruned_articles_feed ON pruned_articles(feed_id);
      `);
    },
  },

  {
    id: 'v8-fts-rowid-map',
    up: (db) => {
      // FTS 行定位映射：item_id 在 articles_fts 里是 UNINDEXED 列，按它查/删都是
      // 全表扫描——灌文高峰（每天数百篇 × 数百 MB 索引）曾把主进程堵死数分钟。
      // 映射表提供 O(log n) 的 rowid 定位；此处回填一次全扫，此后增删改全走映射。
      // 注意：VACUUM / FTS 'rebuild' 可能重排 rowid，执行后须调 SearchIndex.rebuildMap。
      try {
        const hasFts = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='articles_fts'"
        ).get();
        if (!hasFts) return;
        db.exec(`
          CREATE TABLE IF NOT EXISTS articles_fts_map (
              item_id   TEXT PRIMARY KEY NOT NULL,
              fts_rowid INTEGER NOT NULL
          );
        `);
        db.exec(`
          INSERT OR IGNORE INTO articles_fts_map (item_id, fts_rowid)
          SELECT item_id, rowid FROM articles_fts WHERE item_id IS NOT NULL;
        `);
      } catch (_) { /* FTS 不可用：SearchIndex 全程空操作 */ }
    },
  },

  {
    id: 'v9-knowledge-evolution-schema',
    up: (db) => {
      // 知识引擎 + 自进化引擎的表结构（P2-2：原先由引擎构造器 ad-hoc CREATE TABLE，
      // 违反「DDL 必须走迁移链」铁律）。IF NOT EXISTS 语义保留——已有库升级时
      // 表与数据原样保留（幂等），新库由本迁移一次建齐。
      db.exec(`
        CREATE TABLE IF NOT EXISTS highlights (
          id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, text TEXT NOT NULL,
          color TEXT DEFAULT 'yellow', note TEXT, paragraph_id TEXT,
          start_offset INTEGER, end_offset INTEGER, created_at REAL NOT NULL,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, content TEXT NOT NULL,
          tags TEXT, linked_notes TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS review_queue (
          id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, highlight_id TEXT,
          ease_factor REAL DEFAULT 2.5, interval_days INTEGER DEFAULT 1, repetitions INTEGER DEFAULT 0,
          next_review_at REAL NOT NULL, last_reviewed_at REAL,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS smart_folders (
          id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL,
          filters TEXT, sort_by TEXT DEFAULT 'date', created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS article_tags (
          item_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT DEFAULT 'auto',
          PRIMARY KEY(item_id, tag), FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS reading_stats (
          date TEXT PRIMARY KEY NOT NULL, articles_read INTEGER DEFAULT 0,
          articles_starred INTEGER DEFAULT 0, highlights_made INTEGER DEFAULT 0,
          notes_created INTEGER DEFAULT 0, ai_summaries_generated INTEGER DEFAULT 0,
          reading_time_minutes REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collection_items (
          collection_id TEXT NOT NULL, item_id TEXT NOT NULL, added_at REAL NOT NULL,
          PRIMARY KEY(collection_id, item_id),
          FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ai_quality_scores (
          item_id TEXT PRIMARY KEY NOT NULL, rule_score INTEGER, ai_score REAL,
          ai_reasoning TEXT, ai_keywords TEXT, ai_reading_level TEXT,
          is_technical INTEGER DEFAULT 0, scored_at REAL NOT NULL,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS feed_health (
          feed_id TEXT PRIMARY KEY NOT NULL,
          fetch_success_count INTEGER DEFAULT 0,
          fetch_failure_count INTEGER DEFAULT 0,
          consecutive_failures INTEGER DEFAULT 0,
          last_success_at REAL,
          last_failure_at REAL,
          last_error TEXT,
          entry_count INTEGER DEFAULT 0,
          is_dead INTEGER DEFAULT 0,
          FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS reading_behavior (
          id TEXT PRIMARY KEY NOT NULL,
          item_id TEXT NOT NULL,
          feed_id TEXT,
          action TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          created_at REAL NOT NULL,
          FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_behavior_item ON reading_behavior(item_id);
        CREATE INDEX IF NOT EXISTS idx_behavior_feed ON reading_behavior(feed_id);
        CREATE TABLE IF NOT EXISTS ai_feedback (
          id TEXT PRIMARY KEY NOT NULL,
          item_id TEXT,
          kind TEXT NOT NULL,
          rating INTEGER NOT NULL,
          comment TEXT,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS interest_profile (
          key TEXT PRIMARY KEY NOT NULL,
          value REAL NOT NULL,
          updated_at REAL NOT NULL
        );
      `);
      // 2026-08 批注锚点升级：高亮/笔记带重锚定上下文（原引擎构造器里的幂等加列，随 DDL 一并入链）
      for (const [table, column] of [['highlights', 'anchor'], ['notes', 'anchor']]) {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        } catch (_) { /* 列已存在：幂等重入 */ }
      }
    },
  },

  {
    id: 'v10-articles-url-norm',
    up: (db) => {
      // 规范化 url 列（P2-5）：同 feed 判重原先对 REPLACE(a.url,'&amp;','&') 做全表函数
      // 计算（索引失效）。落成实列 + 索引后判重为等值匹配；写入点（upsertEntry）同步维护。
      try {
        db.exec('ALTER TABLE articles ADD COLUMN url_norm TEXT');
      } catch (_) { /* 列已存在：幂等重入 */ }
      db.exec(`
        UPDATE articles SET url_norm = REPLACE(url, '&amp;', '&')
        WHERE url IS NOT NULL AND url != '';
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_url_norm ON articles(url_norm);');
    },
  },

  {
    id: 'v11-feed-fulltext-stats',
    up: (db) => {
      // 全文抓取引擎（F1）每源指标：已补抓篇数 / 失败数 / 最近补抓时间。
      // 订阅源体检仪表盘（F11）后续直接读该表；源删除级联清行。
      db.exec(`
        CREATE TABLE IF NOT EXISTS feed_fulltext_stats (
            feed_id         TEXT PRIMARY KEY NOT NULL,
            fetched_count   INTEGER NOT NULL DEFAULT 0,
            failed_count    INTEGER NOT NULL DEFAULT 0,
            last_fetched_at REAL,
            updated_at      REAL NOT NULL,

            FOREIGN KEY(feed_id)
                REFERENCES feeds(id)
                ON DELETE CASCADE
        );
      `);
    },
  },

  {
    id: 'v12-filter-rules',
    up: (db) => {
      // 规则过滤引擎（F2）：作用域 + 条件 + 动作的自动化规则（对标 Inoreader Filters）。
      // - scope_json：{"kind":"all"}（全局）或 {"kind":"feeds","ids":[feedID,...]}（指定源多选）
      // - conditions_json：{"mode":"all"|"any","list":[{field,op,value}]}（mode=全部/任一满足）
      // - actions_json：["read"|"star"|"later"|"tag:<名>"]（可多选；打标签复用 article_tags）
      // - priority 越小越先执行（列表顺序），hit_count 供编辑器回显命中量。
      db.exec(`
        CREATE TABLE IF NOT EXISTS filter_rules (
            id              TEXT PRIMARY KEY NOT NULL,
            name            TEXT NOT NULL,
            scope_json      TEXT NOT NULL,
            conditions_json TEXT NOT NULL,
            actions_json    TEXT NOT NULL,
            enabled         INTEGER NOT NULL DEFAULT 1,
            priority        INTEGER NOT NULL DEFAULT 0,
            hit_count       INTEGER NOT NULL DEFAULT 0,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_filter_rules_priority
        ON filter_rules(priority, enabled);
      `);
    },
  },
  {
    id: 'v13-media-items',
    up: (db) => {
      // 媒体中心（F3）：RSS enclosure（播客音频/视频）媒体条目与播放状态。
      // - item_id 与 items 主键同构（一篇文章至多一条主媒体，PK 即防重）；
      // - kind: audio | video（mime 或扩展名推断）；
      // - duration_seconds / size_bytes 可空（RSS 常缺，下载完成后回填 size）；
      // - played_at = 最近一次播放时间；position_seconds = 续播位置（>95% 自动归零
      //   即视为播完，「已播完」= played_at 非空且 position 为 0）；
      // - download_state: none | downloading | done | failed（离线收听）；
      //   local_path 为 userData/media/ 内的落盘文件，播放器优先本地。
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_items (
            item_id          TEXT PRIMARY KEY NOT NULL,
            url              TEXT NOT NULL,
            mime             TEXT,
            kind             TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','video')),
            duration_seconds REAL,
            size_bytes       INTEGER,
            played_at        REAL,
            position_seconds REAL,
            download_state   TEXT NOT NULL DEFAULT 'none' CHECK (download_state IN ('none','downloading','done','failed')),
            download_error   TEXT,
            local_path       TEXT,
            created_at       REAL NOT NULL,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_media_items_created
        ON media_items(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_media_items_played
        ON media_items(played_at);
      `);
    },
  },
];

/** 应用所有未执行的迁移（等价 GRDB DatabaseMigrator.migrate）。 */
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    applied_at REAL NOT NULL
  );`);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now() / 1000
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

module.exports = { runMigrations, MIGRATIONS };
