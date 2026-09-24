import { z } from 'zod';
import type { Pool } from 'pg';

export const preferencesSchema = z
  .object({
    notificationRule: z.string().max(4000),
    timeZone: z.string().max(100),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  notificationRule:
    'Only interrupt me for a time-sensitive message that needs my reply, a meaningful calendar change affecting me, or a concrete next step for an active goal. Keep newsletters, routine updates, uncertain relevance and repeated reminders quiet.',
  timeZone: 'Europe/Lisbon',
  quietStart: '22:00',
  quietEnd: '08:00',
};
const columns =
  'notification_rule AS "notificationRule",time_zone AS "timeZone",quiet_start AS "quietStart",quiet_end AS "quietEnd"';
export function createPreferencesStore(pool: Pool, ownerId: string) {
  return {
    async get(): Promise<Preferences> {
      const result = await pool.query(`SELECT ${columns} FROM preferences WHERE owner_id=$1`, [
        ownerId,
      ]);
      return result.rows[0] ?? { ...defaultPreferences };
    },
    async update(raw: unknown): Promise<Preferences> {
      const patch = preferencesSchema.partial().parse(raw);
      if (patch.timeZone !== undefined) new Intl.DateTimeFormat('en', { timeZone: patch.timeZone });
      const result = await pool.query(
        `INSERT INTO preferences(owner_id,notification_rule,time_zone,quiet_start,quiet_end)
        VALUES($1,COALESCE($2,$6),COALESCE($3,$7),COALESCE($4,$8),COALESCE($5,$9))
        ON CONFLICT(owner_id) DO UPDATE SET notification_rule=COALESCE($2,preferences.notification_rule),
        time_zone=COALESCE($3,preferences.time_zone),quiet_start=COALESCE($4,preferences.quiet_start),quiet_end=COALESCE($5,preferences.quiet_end)
        RETURNING ${columns}`,
        [
          ownerId,
          patch.notificationRule ?? null,
          patch.timeZone ?? null,
          patch.quietStart ?? null,
          patch.quietEnd ?? null,
          defaultPreferences.notificationRule,
          defaultPreferences.timeZone,
          defaultPreferences.quietStart,
          defaultPreferences.quietEnd,
        ],
      );
      return result.rows[0];
    },
  };
}
