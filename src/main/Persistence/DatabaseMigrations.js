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
  {
    id: 'v14-topics',
    up: (db) => {
      // 话题盯梢（F4）：关键词 → 三路（本库/AIHOT/源池）聚合的专属信息流。
      // - topics.keywords_json: string[]（1-3 个）；lanes_json: { local, aihot, pool }；
      // - frequency: refresh（每次刷新后自动聚合）| daily（24h 一次）；
      // - ai_filter: 聚合时用 LLM 对候选做相关度精筛（无 Key 自动降级关闭）；
      // - topic_hits: 聚合命中（UNIQUE(topic_id,url_norm) 去重；每话题滚动保留 200 条）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS topics (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            keywords_json  TEXT NOT NULL,
            lanes_json     TEXT NOT NULL,
            frequency   TEXT NOT NULL DEFAULT 'refresh' CHECK (frequency IN ('refresh','daily')),
            ai_filter   INTEGER NOT NULL DEFAULT 0,
            enabled     INTEGER NOT NULL DEFAULT 1,
            last_run    REAL,
            hit_count   INTEGER NOT NULL DEFAULT 0,
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS topic_hits (
            id            TEXT PRIMARY KEY NOT NULL,
            topic_id      TEXT NOT NULL,
            lane          TEXT NOT NULL CHECK (lane IN ('local','aihot','pool')),
            title         TEXT NOT NULL,
            url           TEXT NOT NULL,
            url_norm      TEXT NOT NULL,
            summary       TEXT,
            source_name   TEXT,
            entry_id      TEXT,
            published_at  REAL,
            hit_at        REAL NOT NULL,

            FOREIGN KEY(topic_id)
                REFERENCES topics(id)
                ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_hits_unique
        ON topic_hits(topic_id, url_norm);
        CREATE INDEX IF NOT EXISTS idx_topic_hits_recent
        ON topic_hits(topic_id, hit_at DESC);
      `);
    },
  },
  {
    id: 'v15-platform-feeds',
    up: (db) => {
      // 中文平台适配器（F5）：平台源 = 由平台适配器抓取的合成订阅流。
      // - platform: 'web'（默认，普通 RSS/Atom/JSON Feed）| 'bilibili' | 'weibo'；
      // - platform_ref: 平台内身份（UP 主 UID / 微博 UID），普通源为 NULL；
      // - feed_url 存合成 URL（bilibili://user/:uid / weibo://user/:uid），沿用既有
      //   feed_url 唯一判重与 is_dead 语义，平台列只作分派与展示用。
      // 加列走幂等 try/catch（v6/v10 同款：列已存在时重入跳过）。
      try {
        db.exec('ALTER TABLE feeds ADD COLUMN platform TEXT NOT NULL DEFAULT \'web\'');
      } catch (_) { /* 列已存在：幂等重入 */ }
      try {
        db.exec('ALTER TABLE feeds ADD COLUMN platform_ref TEXT');
      } catch (_) { /* 列已存在：幂等重入 */ }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_feeds_platform
        ON feeds(account_id, platform, platform_ref);
      `);
    },
  },
  {
    id: 'v16-mail-accounts',
    up: (db) => {
      // Newsletter 收件（F6）：IMAP 邮箱账户。
      // - 密码本体绝不落库：password_ref 指向 CredentialStore（DPAPI 加密文件）的
      //   key（mail-password-<id>），删账户时随凭据一并清除；
      // - allow_self_signed：企业内网自签名证书白名单（默认 0 = 严格校验）；
      // - last_sync：账户级增量游标（SEARCH SINCE 的基准，成功刷新后才推进）；
      // - 白名单发件人复用 feeds 表（platform='mail'，platform_ref=发件人地址，
      //   feed_url=mail://<accountId>/<sender>），本表不冗余存发件人。
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
            id                TEXT PRIMARY KEY NOT NULL,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 993,
            username          TEXT NOT NULL,
            password_ref      TEXT NOT NULL,
            allow_self_signed INTEGER NOT NULL DEFAULT 0,
            enabled           INTEGER NOT NULL DEFAULT 1,
            last_sync         REAL,
            created_at        REAL NOT NULL,
            updated_at        REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mail_accounts_enabled
        ON mail_accounts(enabled);
      `);
    },
  },
  {
    id: 'v17-research-reports',
    up: (db) => {
      // AI 深度研究（F8）：带引用编号的流式研究报告 + 追问问答对。
      // - keywords_json: string[]（检索关键词，当前即主题本身）；
      // - report_md: 报告 Markdown 正文；追问问答对以固定分隔标记「### 追问」区段追加；
      // - sources_json: 素材条目数组（{title, source, snippet, url, entryID, lane}），
      //   引用编号 [n] 与数组下标 +1 严格对应；
      // - is_complete: 0 = 草稿（生成中被取消/中断，已收到的部分保留），1 = 完整报告。
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_reports (
            id            TEXT PRIMARY KEY NOT NULL,
            topic         TEXT NOT NULL,
            keywords_json TEXT NOT NULL DEFAULT '[]',
            report_md     TEXT NOT NULL DEFAULT '',
            sources_json  TEXT NOT NULL DEFAULT '[]',
            is_complete   INTEGER NOT NULL DEFAULT 0,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_research_reports_updated
        ON research_reports(created_at DESC);
      `);
    },
  },
  {
    id: 'v18-rag-sessions',
    up: (db) => {
      // 全库 RAG 问答（F9）：多轮问答会话与消息流。
      // - rag_sessions：会话元数据（title=首问前 40 字，可重命名；updated_at 随新消息推进，
      //   历史列表按它倒序——索引建在该列上）；
      // - rag_messages：user|assistant 消息（FK ON DELETE CASCADE 级联删除）；
      //   assistant 行的 sources_json 存本次回答引用的素材数组
      //   （[{kind,title,source,snippet,entryID,url}]，[n] 与数组下标 +1 严格对应），
      //   重开会话后引用芯片与素材浮层据此还原；内容照存——取消保留的已流部分
      //   即「未完成」语义，不另设标记列。
      //   INDEX(session_id, created_at)：会话内消息按时间取窗（多轮上下文）走索引。
      db.exec(`
        CREATE TABLE IF NOT EXISTS rag_sessions (
            id         TEXT PRIMARY KEY NOT NULL,
            title      TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rag_sessions_updated
        ON rag_sessions(updated_at DESC);
        CREATE TABLE IF NOT EXISTS rag_messages (
            id           TEXT PRIMARY KEY NOT NULL,
            session_id   TEXT NOT NULL,
            role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
            content      TEXT NOT NULL DEFAULT '',
            sources_json TEXT NOT NULL DEFAULT '[]',
            created_at   REAL NOT NULL,
            FOREIGN KEY(session_id)
                REFERENCES rag_sessions(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_rag_messages_session
        ON rag_messages(session_id, created_at);
      `);
    },
  },
  {
    id: 'v19-books',
    up: (db) => {
      // 个人文集自动成书（F12）：文集 = 绑定若干订阅源的「书」，可手动/周期成书为 EPUB。
      // - feed_ids_json: string[]（绑定的订阅源 id 列表，可多源）；
      // - schedule: manual（仅手动「立即成书」）| auto（刷新完成后自动成书，≥24h 节流 + 源有新文章才成）；
      // - last_built_at: 上次成书时间（秒；既作自动成书节流基准，也作「有新文章」比较基准）；
      // - last_entry_count: 上次成书收录篇数（书架回显）。
      // 自动成书产物落 userData/books/<bookId>/（应用数据区白名单内，无需 pickSavePath token）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS books (
            id               TEXT PRIMARY KEY NOT NULL,
            title            TEXT NOT NULL,
            feed_ids_json    TEXT NOT NULL DEFAULT '[]',
            schedule         TEXT NOT NULL DEFAULT 'manual' CHECK (schedule IN ('manual','auto')),
            last_built_at    REAL,
            last_entry_count INTEGER NOT NULL DEFAULT 0,
            created_at       REAL NOT NULL,
            updated_at       REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at DESC);
      `);
    },
  },
  {
    id: 'v20-auto-tags',
    up: (db) => {
      // AI 自动标签（F15）：article_tags 的 source 列早在 v9 就已建（TEXT DEFAULT 'auto'，
      // 手动='manual' / AI='ai'）——按铁律先 PRAGMA 检查，已有则零 DDL；只有极老的
      // GRDB 血统库缺列时才幂等补列。索引为本功能的两条热路径服务：
      // - 复核过滤 chips 按 source 聚合（kb:tagsSource）；
      // - AI 批量打标取「最近入库且未打标」按 date_arrived 取窗（原表无该索引）。
      const cols = db.prepare("PRAGMA table_info(article_tags)").all().map((c) => c.name);
      if (!cols.includes('source')) {
        try {
          db.exec("ALTER TABLE article_tags ADD COLUMN source TEXT DEFAULT 'auto'");
        } catch (_) { /* 列已存在：幂等重入 */ }
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_article_tags_source
        ON article_tags(source, tag);
        CREATE INDEX IF NOT EXISTS idx_article_states_arrived
        ON article_states(date_arrived);
      `);
    },
  },
  {
    id: 'v21-monitor-baselines',
    up: (db) => {
      // 网页追更（F18）：无 RSS 页面的 diff 基线。
      // - feed_id 与 feeds 主键同构（monitor 源 = platform='monitor' 的合成 feed），
      //   PK 即「一源一基线」，源删除级联清行；
      // - content_hash：基线正文的 sha1（快速无变化短路，不做逐段 diff）；
      // - baseline_text：上次抓取的正文纯文本（截 512KB，段落 diff 的左操作数）；
      // - page_url / selector：抓取地址与选择器（feeds.site_url/platform_ref 亦存，
      //   此处冗余存证，changeSelector 审计可查）；
      // - checked_at：最近一次实际抓取时间（≥30min 节流的基准，与 updated_at 分离——
      //   无变化时基线不更新，但 checked_at 必须推进）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS monitor_baselines (
            feed_id      TEXT PRIMARY KEY NOT NULL,
            content_hash TEXT NOT NULL DEFAULT '',
            baseline_text TEXT NOT NULL DEFAULT '',
            page_url     TEXT,
            selector     TEXT,
            checked_at   REAL,
            updated_at   REAL NOT NULL,

            FOREIGN KEY(feed_id)
                REFERENCES feeds(id)
                ON DELETE CASCADE
        );
      `);
    },
  },
  {
    id: 'v22-events-transcripts',
    up: (db) => {
      // ── F21 事件聚类去重 ──
      // event_clusters：同一新闻多源重复报道聚成的「事件」簇。
      // - id = 簇身份（uuid）；representative_item_id = 代表条目（最早发布成员，
      //   事件卡收合态展示其标题）；title 冗余存代表标题（免 JOIN 读卡面）；
      // - 成员关系落 items.cluster_id（加列 + 索引）：列表投影一条 LEFT JOIN 即可带出
      //   归属，作用域过滤天然生效；条目删除随 items 级联消失，簇行由服务惰性回收。
      // 加列走幂等 try/catch（v6/v10/v15 同款：列已存在时重入跳过）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_clusters (
            id                     TEXT PRIMARY KEY NOT NULL,
            representative_item_id TEXT NOT NULL,
            title                  TEXT NOT NULL DEFAULT '',
            member_count           INTEGER NOT NULL DEFAULT 0,
            created_at             REAL NOT NULL,
            updated_at             REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_clusters_updated
        ON event_clusters(updated_at DESC);
      `);
      try { db.exec('ALTER TABLE items ADD COLUMN cluster_id TEXT'); }
      catch (_) { /* 列已存在：幂等重入 */ }
      db.exec('CREATE INDEX IF NOT EXISTS idx_items_cluster ON items(cluster_id);');

      // ── F22 播客转文字稿 ──
      // media_transcripts：媒体条目 ↔ 本地 ASR 转写产物（一条媒体至多一份，PK 即防重）。
      // - status 状态机 queued → running → done | error（失败保留 error 与原因，可重试）；
      // - segments_json：端点返回分段时间戳时原样存（[{start,end,text}]），面板渲染时间戳；
      // - summary：转写完成后可选的 AI 摘要（无 Key 灰置，生成后随行回读）；
      // - FK 级联：媒体条目删除（随文章删除）时文字稿一并消失。
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_transcripts (
            item_id          TEXT PRIMARY KEY NOT NULL,
            status           TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','error')),
            text             TEXT NOT NULL DEFAULT '',
            language         TEXT,
            duration_seconds REAL,
            segments_json    TEXT,
            summary          TEXT,
            error            TEXT,
            created_at       REAL NOT NULL,
            updated_at       REAL NOT NULL,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_media_transcripts_status
        ON media_transcripts(status, updated_at DESC);
      `);
      // 文字稿全文检索（F22）：独立 FTS5 trigram 虚表（旁路 articles_fts，互不干扰）。
      // FTS5 不可用的环境静默跳过，搜索层探测不到表即回退 LIKE（v4 同款口径）。
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS media_transcripts_fts USING fts5(
              item_id UNINDEXED,
              text,
              tokenize='trigram'
          );
        `);
      } catch (_) { /* FTS 不可用：转写搜索走 LIKE */ }
    },
  },
  {
    id: 'v23-garden-perspectives',
    up: (db) => {
      // ── F23 知识花园 · 知更养成 ──
      // garden_state：花园单行状态（阳光=连续阅读天数 / 水滴=完读 / 养分=批注 /
      // 成长阶段 / 知更羽毛档 / 枯萎档 / 最近活跃日）。单行语义由 PK CHECK(id=1) 锁定。
      db.exec(`
        CREATE TABLE IF NOT EXISTS garden_state (
            id              INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
            stage           INTEGER NOT NULL DEFAULT 0,
            sun_streak      INTEGER NOT NULL DEFAULT 0,
            water_total     INTEGER NOT NULL DEFAULT 0,
            seed_total      INTEGER NOT NULL DEFAULT 0,
            wilt_level      INTEGER NOT NULL DEFAULT 0,
            last_active_day TEXT,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL
        );
      `);
      // garden_events：花园事件流水（water=浇水 / seed=种子 / wilt=枯萎 / revive=复活 /
      // stage=阶段跃迁 / feather=羽毛升级）。UNIQUE(kind, ref) 是防刷地基：
      // 同一篇文章完读只浇一次水（ref=entryID）、同一条批注只结一颗种子（ref=批注 id）、
      // 同一天的枯萎/复活只记一次（ref=日期）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS garden_events (
            id           TEXT PRIMARY KEY NOT NULL,
            kind         TEXT NOT NULL CHECK (kind IN ('water','seed','wilt','revive','stage','feather')),
            ref          TEXT NOT NULL,
            day          TEXT NOT NULL,
            points       INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT,
            created_at   REAL NOT NULL,
            UNIQUE(kind, ref)
        );
        CREATE INDEX IF NOT EXISTS idx_garden_events_day ON garden_events(day);
      `);

      // ── F24 观点对照镜 ──
      // perspectives：当前文章 ↔ 历史旧文的观点关系判定结果（AI 产物持久化）。
      // - relation：contradict（唱反调）/ complement（相辅相成）/ echo（遥相呼应）/
      //   none（无关）。none 一并入库是省 token 的关键决策：同一对文章判定过「无关」
      //   后不再重复送 LLM（唯一约束防重 + 读取侧只投影前三类）。
      // - PRIMARY KEY(entry_id, related_entry_id) 即「同一对文章不重复判」。
      // - 无外键：相关条目可能先于本表行被清理（淘汰墓碑/同步删除），关系随条目
      //   消失属可接受损耗，读取侧 JOIN 自然过滤，避免级联误删判定历史。
      db.exec(`
        CREATE TABLE IF NOT EXISTS perspectives (
            entry_id           TEXT NOT NULL,
            related_entry_id   TEXT NOT NULL,
            relation           TEXT NOT NULL
                CHECK (relation IN ('contradict','complement','echo','none')),
            reason             TEXT NOT NULL DEFAULT '',
            model              TEXT,
            created_at         REAL NOT NULL,
            PRIMARY KEY (entry_id, related_entry_id)
        );
        CREATE INDEX IF NOT EXISTS idx_perspectives_entry ON perspectives(entry_id, created_at DESC);
      `);
    },
  },
  {
    id: 'v24-debates-quizzes',
    up: (db) => {
      // ── F25 AI 反方辩手 ──
      // debates：钢人辩论会话（一篇文章可多次辩论，进行中（open）仅一场——单飞由
      //   服务层锁保证，历史 closed 行保留供回看）。
      // - status: open（进行中）| closed（已裁决）| verdict_up | verdict_down
      //   （verdict_* 为历史兼容口径；本版裁决只写 status='closed' + verdict 列）；
      // - rounds_json：完整回合流 [{role:'ai'|'user', kind:'opening'|'reply'|'user',
      //   content, quotes:[原文引用], at}]——单列 JSON 免建回合子表（回合只随会话整体读写）；
      // - verdict：verdict_up（反方说服了我）| verdict_down（我坚持原文），裁决后定格。
      db.exec(`
        CREATE TABLE IF NOT EXISTS debates (
            id          TEXT PRIMARY KEY NOT NULL,
            entry_id    TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','closed','verdict_up','verdict_down')),
            rounds_json TEXT NOT NULL DEFAULT '[]',
            verdict     TEXT
                CHECK (verdict IS NULL OR verdict IN ('verdict_up','verdict_down')),
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL,

            FOREIGN KEY(entry_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_debates_entry
        ON debates(entry_id, created_at DESC);
      `);

      // ── F26 读后点亮测验 ──
      // quizzes：一篇可重测（每次生成新行），保留全部作答历史——
      //   最高分 = MAX(score)，最近一次 = created_at DESC 首行，读取侧投影。
      // - questions_json：[{q, options:[4], answer, explain}]；
      // - score / answered_at：提交作答后回填（未答为 NULL）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS quizzes (
            id            TEXT PRIMARY KEY NOT NULL,
            entry_id      TEXT NOT NULL,
            questions_json TEXT NOT NULL DEFAULT '[]',
            score         INTEGER,
            answered_at   REAL,
            created_at    REAL NOT NULL,

            FOREIGN KEY(entry_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_quizzes_entry
        ON quizzes(entry_id, created_at DESC);
      `);
      // quiz_lights：点亮表（图谱是运行期合成——article_tags 投影 + 此处点亮合并）。
      // PK(tag, entry_id) 防重：同一篇文章的同一标签只点亮一次（重测高分不重复计）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS quiz_lights (
            tag        TEXT NOT NULL,
            entry_id   TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (tag, entry_id),

            FOREIGN KEY(entry_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_quiz_lights_tag
        ON quiz_lights(tag);
      `);
      // 复习卡来源标记（错题 → SM-2 复习卡，来源='quiz'）+ 错题快照
      // （review_queue 无正文列，高亮卡靠 JOIN highlights；测验卡把题目/答案/
      //   解析存 quiz_json，复习面板据此渲染卡面）。加列走幂等 try/catch
      // （v6/v10/v15/v20 同款：列已存在时重入跳过）。
      try { db.exec("ALTER TABLE review_queue ADD COLUMN source TEXT"); }
      catch (_) { /* 列已存在：幂等重入 */ }
      try { db.exec('ALTER TABLE review_queue ADD COLUMN quiz_json TEXT'); }
      catch (_) { /* 列已存在：幂等重入 */ }
      db.exec('CREATE INDEX IF NOT EXISTS idx_review_queue_source ON review_queue(source);');
    },
  },
  {
    id: 'v25-capsules-bundle-origin',
    up: (db) => {
      // ── F27 时间胶囊 ──
      // time_capsules：批注（高亮/笔记）封存给未来的自己，open_at 到期后随每日简报
      //   顶部「时间胶囊」段浮出（懒结算：到期判定发生在读取时，无定时器）。
      // - annotation_kind + annotation_id：高亮（highlights）/笔记（notes）二选一的
      //   来源指认——两类批注分表存储，单列 annotation_id 无法定位表。
      // - 不设外键：文章删除随 items 级联会连带删批注，胶囊作为「写给未来的信」
      //   保留封存凭证（历史报告不消失），读取侧 JOIN 不到批注/文章时按缺失上下文
      //   降级展示，与「永不删除红线」精神一致。
      // - status: sealed（封存中）| opened（已开启）。opened 即不再进简报段
      //   （防重复浮出），但保留在历史报告里（opens_count 记录开启次数）。
      // - message：封存时写给未来自己的一句话（可选，纯文本截断落库）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS time_capsules (
            id              TEXT PRIMARY KEY NOT NULL,
            annotation_id   TEXT NOT NULL,
            annotation_kind TEXT NOT NULL CHECK (annotation_kind IN ('highlight','note')),
            entry_id        TEXT NOT NULL,
            open_at         REAL NOT NULL,
            opens_count     INTEGER NOT NULL DEFAULT 0,
            status          TEXT NOT NULL DEFAULT 'sealed' CHECK (status IN ('sealed','opened')),
            message         TEXT,
            created_at      REAL NOT NULL,
            opened_at       REAL
        );
        CREATE INDEX IF NOT EXISTS idx_time_capsules_open_at
        ON time_capsules(status, open_at);
        CREATE INDEX IF NOT EXISTS idx_time_capsules_entry
        ON time_capsules(entry_id);
      `);

      // ── F28 批注漂流瓶 ──
      // 导入来源标记：.robin 包导入的批注 origin='imported'（本机原生为 NULL），
      // origin_id = 包内批注 uid（哈希）——再导出时带上，往返不丢；重复导入按
      // origin_id / anchor+文本哈希去重，冲突（同位置不同内容）并存不覆盖。
      // 加列走幂等 try/catch（v6/v9/v15 同款：列已存在时重入跳过）。
      for (const table of ['highlights', 'notes']) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN origin TEXT`); }
        catch (_) { /* 列已存在：幂等重入 */ }
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN origin_id TEXT`); }
        catch (_) { /* 列已存在：幂等重入 */ }
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_highlights_origin ON highlights(origin_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_origin ON notes(origin_id);');
    },
  },
  {
    id: 'v26-weeklies-courses',
    up: (db) => {
      // ── F29 AI 周刊编辑部 ──
      // weeklies：一期一行的周刊产物（AI 导语 + 主题板块 + 金句的 content_json）。
      // - week_start：聚合窗口起点（该周周一的本地日期 YYYY-MM-DD），UNIQUE 防重——
      //   同一周重复生成/自动触发重入都落同一行（失败可重试覆盖，ready 幂等返回）；
      // - status: generating（生成中，可取消）| ready（可读可导出）| failed（可重试）；
      // - content_json：版面数据 { intro, sections:[{title,summary,entries:[…]}],
      //   quotes:[{text,entryID,title,sourceTitle}], template, generatedAt }；
      // - error：failed 时的原因（取消/解析失败/空窗口），渲染层据此给重试按钮。
      db.exec(`
        CREATE TABLE IF NOT EXISTS weeklies (
            id           TEXT PRIMARY KEY NOT NULL,
            week_start   TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating','ready','failed')),
            content_json TEXT,
            error        TEXT,
            created_at   REAL NOT NULL,
            updated_at   REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_weeklies_week ON weeklies(week_start);
        CREATE INDEX IF NOT EXISTS idx_weeklies_created ON weeklies(created_at DESC);
      `);

      // ── F30 自学课程引擎 ──
      // courses：学习目标 → 7/14 天课程大纲（plan_json 承载 LLM 大纲原始合同）。
      // - status: active（进行中）| done（毕业）| abandoned（放弃）；重建 = 新行。
      // - days_total：7 或 14（进度条分母）；plan_json 存生成侧账（候选/耗时/模型），
      //   每日事实以 course_days 为准（day 可独立完成/勾选）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS courses (
            id          TEXT PRIMARY KEY NOT NULL,
            goal        TEXT NOT NULL,
            plan_json   TEXT,
            status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','done','abandoned')),
            days_total  INTEGER NOT NULL DEFAULT 14,
            error       TEXT,
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_courses_created ON courses(status, created_at DESC);
      `);
      // course_days：一天一行，PK(course_id, day) 即 UNIQUE 约束（同课同天唯一）。
      // - point：当日学习要点一句话；entry_ids_json：当日文章 ID 数组（真实存在校验后落库）；
      // - completed_at：完成打卡时间（NULL=未完成）——「完成本日才解锁下一天」的判定列。
      db.exec(`
        CREATE TABLE IF NOT EXISTS course_days (
            course_id      TEXT NOT NULL,
            day            INTEGER NOT NULL,
            point          TEXT,
            entry_ids_json TEXT NOT NULL DEFAULT '[]',
            completed_at   REAL,
            PRIMARY KEY (course_id, day),
            FOREIGN KEY(course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE
        );
      `);
    },
  },
  {
    id: 'v27-reading-clock',
    up: (db) => {
      // ── F36 阅读生物钟 ──
      // reading_clock：阅读行为的小时桶（一天 × 24 小时，近月滚动保留）。
      // - 规格「hour 0-23 PK」补充 day 列：同一规格里的「近 7 天样本加权（近一天
      //   权重高）」需要天归属——纯 hour 主键无法区分今天与六天前的样本，故
      //   PK(day, hour)（一天每至多一行 × 24 桶），24 小时桶热力条 = 窗口聚合投影。
      // - count：markRead（未读→已读）次数；total_ms：阅读器开启时的阅读时长脉冲
      //   累计（渲染层 15s 心跳喂入，单脉冲钳制防休眠虚增）。
      // - 滚动保留：服务层惰性删除 KEEP_DAYS 窗外旧行（表体量 = 天数 × ≤24 行）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS reading_clock (
            day       TEXT NOT NULL,
            hour      INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
            count     INTEGER NOT NULL DEFAULT 0,
            total_ms  INTEGER NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL,
            PRIMARY KEY (day, hour)
        );
        CREATE INDEX IF NOT EXISTS idx_reading_clock_day ON reading_clock(day);
      `);
    },
  },
  {
    id: 'v28-translations-archives',
    up: (db) => {
      // ── F33 外文源自动译 ──
      // translations：整篇译文缓存（一篇文章至多一份，PK 即防重——已有译文零请求幂等）。
      // - lang：译文目标语言（跟随界面语言）；
      // - translated_html：拼接完成的整篇译文（过 ArticleExtractor 消毒白名单后才落库——
      //   LLM 输出不可信，script/iframe 等在写入前剥除）；
      // - segments_json：分块翻译的「已完成块」进度（[{i, html}]）——中途失败保留进度，
      //   重试从断点续译（全部块完成后拼接并清空本列）；
      // - is_complete：0 = 生成中/中断（可续译），1 = 完整可切换。
      db.exec(`
        CREATE TABLE IF NOT EXISTS translations (
            item_id         TEXT PRIMARY KEY NOT NULL,
            lang            TEXT NOT NULL DEFAULT 'zh',
            translated_html TEXT NOT NULL DEFAULT '',
            segments_json   TEXT,
            is_complete     INTEGER NOT NULL DEFAULT 0,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_translations_complete
        ON translations(is_complete, updated_at DESC);
      `);

      // ── F34 网页存档馆 ──
      // archives：重要文章 + 追更源的永久本地快照（原文失效也能读，可导 MHTML）。
      // - html_captured：文章当前正文 HTML 原样存档（入库消毒 HTML 或全文抓取 HTML）；
      // - html_size：字节体积（单篇 ≤6MB 闸的判定列 + 存档馆体积统计）；
      // - captured_at：快照时间（重存档覆盖更新）；FK 级联随文章删除清行。
      db.exec(`
        CREATE TABLE IF NOT EXISTS archives (
            item_id       TEXT PRIMARY KEY NOT NULL,
            html_captured TEXT NOT NULL,
            captured_at   REAL NOT NULL,
            html_size     INTEGER NOT NULL DEFAULT 0,

            FOREIGN KEY(item_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_archives_captured
        ON archives(captured_at DESC);
      `);
    },
  },
  {
    id: 'v29-revisits-source-profiles',
    up: (db) => {
      // ── F37 深读重访 ──
      // revisits：长文（正文 ≥1500 字）首次读完时登记的重访计划（遗忘曲线温和重现）。
      // - entry_id UNIQUE：同一篇文章终身至多一条重访计划（登记侧 INSERT OR IGNORE，
      //   防重复登记；文章删除随 items 级联清行）；
      // - due：到期时刻（read_at + 30d 起算；done/skipped 推迟时 += DEFER_DAYS）；
      // - status: pending（待重访）| done（已读过了，终态不再浮出）|
      //   skipped（稍后再说，due 过后由读取侧懒结算翻回 pending 再浮出）；
      // - guidance_json：AI 重读指引缓存（3 条指引一次一存，重开零 token——防重复烧钱）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS revisits (
            id            TEXT PRIMARY KEY NOT NULL,
            entry_id      TEXT NOT NULL UNIQUE,
            read_at       REAL NOT NULL,
            due           REAL NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','skipped')),
            guidance_json TEXT,
            created_at    REAL NOT NULL,

            FOREIGN KEY(entry_id)
                REFERENCES items(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_revisits_due
        ON revisits(status, due);
      `);

      // ── F38 来源立场光谱 ──
      // source_profiles：订阅源的立场/风格画像缓存（LLM 批量分析的持久化产物）。
      // - feed_id PK：一源一画像（重析覆盖）；FK 级联随源删除清行；
      // - profile_json：{spectrum, style, portrait}（-100 技术实用 … +100 观点人文）；
      // - analyzed_at：分析时刻（7 天过期重析的判定列；过期与否纯读取侧对比）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_profiles (
            feed_id      TEXT PRIMARY KEY NOT NULL,
            profile_json TEXT NOT NULL DEFAULT '{}',
            analyzed_at  REAL NOT NULL,

            FOREIGN KEY(feed_id)
                REFERENCES feeds(id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_source_profiles_analyzed
        ON source_profiles(analyzed_at);
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
