import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ProjectGroupRow } from '@/shared/types.js';

/** Named sidebar folders. Membership lives on `projects.group_id`. */
export const projectGroupsDb = {
    listGroups(): ProjectGroupRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT group_id, name, created_at
            FROM project_groups
            ORDER BY name COLLATE NOCASE
        `).all() as ProjectGroupRow[];
    },

    getGroupById(groupId: string): ProjectGroupRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT group_id, name, created_at
            FROM project_groups
            WHERE group_id = ?
        `).get(groupId) as ProjectGroupRow | undefined;
        return row ?? null;
    },

    getGroupByName(name: string): ProjectGroupRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT group_id, name, created_at
            FROM project_groups
            WHERE name = ? COLLATE NOCASE
        `).get(name) as ProjectGroupRow | undefined;
        return row ?? null;
    },

    createGroup(name: string): ProjectGroupRow {
        const db = getConnection();
        return db.prepare(`
            INSERT INTO project_groups (group_id, name)
            VALUES (?, ?)
            RETURNING group_id, name, created_at
        `).get(randomUUID(), name) as ProjectGroupRow;
    },

    renameGroup(groupId: string, name: string): void {
        const db = getConnection();
        db.prepare('UPDATE project_groups SET name = ? WHERE group_id = ?').run(name, groupId);
    },

    /** Removes the group; its projects fall back to ungrouped. */
    deleteGroup(groupId: string): void {
        const db = getConnection();
        db.transaction(() => {
            db.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(groupId);
            db.prepare('DELETE FROM project_groups WHERE group_id = ?').run(groupId);
        })();
    },
};
