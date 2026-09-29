import type { Pool, PoolClient } from 'pg';

export async function migrateLegacyThreads(database: Pool | PoolClient) {
  await database.query(`
    DO $$
    DECLARE relation_name text;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='tasks')
        OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='conversations') THEN
        RETURN;
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':legacy-threads',0));
      CREATE TEMP TABLE legacy_thread_tasks ON COMMIT DROP AS
        SELECT t.id,t.owner_id,t.prompt,t.status,t.created_at,t.updated_at,
          COALESCE(to_jsonb(t)->>'source','user') AS source,to_jsonb(t)->>'source_id' AS source_id,
          COALESCE(to_jsonb(t)->>'channel','web') AS channel,to_jsonb(t)->>'waiting_reason' AS waiting_reason,
          COALESCE((to_jsonb(t)->>'conversation_revision')::integer,0)=COALESCE(c.revision,0) AS current
        FROM tasks t LEFT JOIN conversations c ON c.owner_id=t.owner_id AND c.channel=COALESCE(to_jsonb(t)->>'channel','web');
      INSERT INTO threads(id,owner_id)
        SELECT COALESCE(latest.id,gen_random_uuid()),o.owner_id FROM (
          SELECT owner_id FROM legacy_thread_tasks t WHERE NOT EXISTS (SELECT 1 FROM turns u WHERE u.id=t.id)
          UNION SELECT owner_id FROM messages WHERE thread_id IS NULL
        ) o LEFT JOIN LATERAL (
          SELECT id FROM legacy_thread_tasks t WHERE t.owner_id=o.owner_id AND t.current
          ORDER BY t.updated_at DESC,t.created_at DESC,t.id DESC LIMIT 1
        ) latest ON true
        WHERE NOT EXISTS (SELECT 1 FROM threads th WHERE th.owner_id=o.owner_id AND th.archived_at IS NULL);
      INSERT INTO threads(id,owner_id,archived_at)
        SELECT gen_random_uuid(),o.owner_id,now() FROM (
          SELECT owner_id FROM legacy_thread_tasks t WHERE NOT t.current AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.id=t.id)
          UNION SELECT owner_id FROM messages WHERE thread_id IS NULL
        ) o WHERE NOT EXISTS (SELECT 1 FROM threads th WHERE th.owner_id=o.owner_id AND th.archived_at IS NOT NULL);
      INSERT INTO turns(id,owner_id,thread_id,source,source_id,message_id,prompt,channel,status,waiting_reason,background,read_only,error,created_at,finished_at)
        SELECT t.id,t.owner_id,th.id,CASE WHEN t.source IN ('user','schedule','event') THEN t.source ELSE 'event' END,
          t.source_id,m.id,t.prompt,t.channel,
          CASE WHEN t.status IN ('succeeded','failed','cancelled') THEN t.status
            WHEN t.id=th.id AND t.status='waiting_user' AND t.waiting_reason='question' THEN 'waiting' ELSE 'failed' END,
          CASE WHEN t.id=th.id AND t.status='waiting_user' AND t.waiting_reason='question' THEN 'question' END,
          t.source<>'user',COALESCE(t.source_id LIKE 'onboarding:%',false),
          CASE WHEN t.status NOT IN ('succeeded','cancelled') AND NOT (t.id=th.id AND t.status='waiting_user' AND t.waiting_reason='question')
            THEN 'This task was interrupted by the upgrade. Check any outside actions before continuing.' END,
          CASE WHEN t.id=th.id THEN t.updated_at ELSE t.created_at END,t.updated_at
        FROM legacy_thread_tasks t JOIN LATERAL (
          SELECT id FROM threads th WHERE th.owner_id=t.owner_id AND (th.archived_at IS NULL)=t.current
          ORDER BY th.created_at,th.id LIMIT 1
        ) th ON true LEFT JOIN LATERAL (
          SELECT id FROM messages m WHERE m.owner_id=t.owner_id AND m.task_id=t.id AND m.role='user'
          ORDER BY m.created_at DESC,m.id DESC LIMIT 1
        ) m ON true
        ON CONFLICT(id) DO NOTHING;
      UPDATE messages m SET thread_id=u.thread_id,turn_id=u.id FROM turns u
        WHERE m.task_id=u.id AND m.owner_id=u.owner_id AND m.turn_id IS NULL;
      UPDATE messages m SET thread_id=th.id FROM threads th
        WHERE m.task_id IS NULL AND m.thread_id IS NULL AND th.owner_id=m.owner_id AND th.archived_at IS NULL
          AND COALESCE((SELECT revision FROM conversations c WHERE c.owner_id=m.owner_id AND c.channel='web'),0)=0;
      UPDATE messages m SET thread_id=th.id FROM threads th
        WHERE m.thread_id IS NULL AND th.owner_id=m.owner_id AND th.archived_at IS NOT NULL
          AND th.id=(SELECT id FROM threads x WHERE x.owner_id=m.owner_id AND x.archived_at IS NOT NULL ORDER BY x.created_at,x.id LIMIT 1);
      UPDATE artifacts a SET thread_id=u.thread_id FROM turns u
        WHERE a.thread_id IS NULL AND a.task_id=u.id AND a.owner_id=u.owner_id;
      UPDATE artifacts a SET thread_id=(SELECT m.thread_id FROM messages m
          WHERE m.owner_id=a.owner_id AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text))
          ORDER BY m.created_at,m.id LIMIT 1)
        WHERE a.thread_id IS NULL;
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='task_events') THEN
        INSERT INTO turn_events(id,turn_id,type,summary,created_at)
          SELECT e.id,u.id,e.type,e.summary,e.created_at FROM task_events e JOIN turns u ON u.id=e.task_id
          ON CONFLICT(id) DO NOTHING;
      END IF;
      FOREACH relation_name IN ARRAY ARRAY['schedule_runs','inspector_prompts','inspector_records','notifications','provider_usage','channel_inbox','approvals'] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=relation_name AND column_name='task_id') THEN
          EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS turn_id uuid REFERENCES turns(id)',relation_name);
          EXECUTE format('UPDATE %I r SET turn_id=u.id FROM turns u WHERE r.turn_id IS NULL AND r.task_id=u.id AND r.owner_id=u.owner_id',relation_name);
        END IF;
      END LOOP;
      FOREACH relation_name IN ARRAY ARRAY['inspector_prompts','inspector_records','approvals'] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=relation_name AND column_name='turn_id') THEN
          EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES threads(id)',relation_name);
          EXECUTE format('UPDATE %I r SET thread_id=u.thread_id FROM turns u WHERE r.thread_id IS NULL AND r.turn_id=u.id AND r.owner_id=u.owner_id',relation_name);
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='approvals' AND column_name='task_id') THEN
        ALTER TABLE approvals ADD COLUMN IF NOT EXISTS execution_turn_id uuid REFERENCES turns(id);
        UPDATE approvals SET execution_turn_id=turn_id WHERE execution_turn_id IS NULL AND execution_revision IS NOT NULL;
        UPDATE approvals SET status='uncertain' WHERE status='executing';
        UPDATE approvals SET status='expired' WHERE task_id IS NOT NULL AND status='pending';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='discovered_connection_proposals' AND column_name='task_id') THEN
        ALTER TABLE discovered_connection_proposals ADD COLUMN IF NOT EXISTS thread_id uuid;
        ALTER TABLE discovered_connection_proposals ADD COLUMN IF NOT EXISTS turn_id uuid;
        UPDATE discovered_connection_proposals p SET thread_id=u.thread_id,turn_id=u.id FROM tasks t,turns u,threads th
          WHERE p.task_id=t.id AND p.owner_id=t.owner_id AND p.task_revision=t.revision
            AND u.id=t.id AND u.owner_id=p.owner_id AND th.id=u.thread_id AND th.archived_at IS NULL
            AND u.id=th.id AND u.status='waiting' AND u.waiting_reason='question' AND p.turn_id IS NULL;
        UPDATE discovered_connection_proposals SET expires_at=LEAST(expires_at,now()) WHERE task_id IS NOT NULL AND turn_id IS NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='app_connections' AND column_name='task_id') THEN
        ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS turn_id uuid;
        UPDATE app_connections p SET turn_id=u.id FROM tasks t,turns u,threads th
          WHERE p.task_id=t.id AND p.owner_id=t.owner_id AND p.task_revision=t.revision
            AND u.id=t.id AND u.owner_id=p.owner_id AND th.id=u.thread_id AND th.archived_at IS NULL
            AND u.id=th.id AND u.status='waiting' AND u.waiting_reason='question' AND p.turn_id IS NULL;
        UPDATE app_connections SET callback_expires=LEAST(callback_expires,now()) WHERE task_id IS NOT NULL AND turn_id IS NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='channel_task_routes')
        AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='channel_outbox') THEN
        INSERT INTO channel_outbox(message_id,source_id,state,reason)
          SELECT m.id,r.source_id,'blocked','legacy_delivery_not_confirmed' FROM channel_task_routes r
          JOIN messages m ON m.turn_id=r.task_id AND m.owner_id=r.owner_id AND m.role='assistant'
          JOIN channel_inbox i ON i.source_id=r.source_id AND i.owner_id=r.owner_id AND i.state='submitted'
          ON CONFLICT(message_id) DO NOTHING;
      END IF;
    END $$;
  `);
}
