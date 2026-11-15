// 讀 meta.mjs，產生灌進 D1 的 SQL：worker/seed.sql
// 用法：node worker/seed.mjs
//      npx wrangler d1 execute ccs --remote --file=worker/seed.sql
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { objects, relations, menus, settings, lineCommands } from './meta.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const q = (v) => (v == null || v === '' ? 'NULL' : "'" + String(v).split("'").join("''") + "'");
const j = (v) => (v == null ? 'NULL' : q(JSON.stringify(v)));
const n = (v) => (v == null ? 0 : Number(v));
const now = new Date().toISOString();
const out = [];

out.push('-- 由 worker/seed.mjs 產生，請勿手改。改 worker/meta.mjs 後重跑。');
out.push('-- 只動設定庫（meta_*）與 settings／line_command，不碰 record。');
out.push('');
out.push('DELETE FROM meta_field;');
out.push('DELETE FROM meta_relation;');
out.push('DELETE FROM meta_menu;');
out.push('DELETE FROM meta_object;');
out.push('');

objects.forEach((o) => {
  out.push(`INSERT INTO meta_object (id,label,label_plural,icon,id_rule,title_field,source,soft_delete,audit_level,acl,sort,status,updated_at,updated_by) VALUES (${[
    q(o.id), q(o.label), q(o.label_plural), q(o.icon), q(o.id_rule), q(o.title_field), q(o.source || 'd1'),
    o.soft_delete === 0 ? 0 : 1, q(o.audit_level || 'full'), j(o.acl), n(o.sort), q(o.status || 'active'), q(now), q('seed'),
  ].join(',')});`);
  o.fields.forEach((f, i) => {
    out.push(`INSERT INTO meta_field (id,object_id,"key",label,type,options,required,is_unique,default_value,validate,privacy,lock_after,show_in_list,sort,help) VALUES (${[
      q(o.id + '.' + f.key), q(o.id), q(f.key), q(f.label), q(f.type), j(f.options),
      n(f.required), n(f.is_unique), q(f.default_value), q(f.validate), q(f.privacy || 'staff'),
      j(f.lock_after), n(f.show_in_list), (i + 1) * 10, q(f.help),
    ].join(',')});`);
  });
  out.push('');
});

relations.forEach((r) => {
  out.push(`INSERT INTO meta_relation (id,label,from_object,to_object,kind,from_label,to_label,on_delete,required,embed,display) VALUES (${[
    q(r.id), q(r.label), q(r.from_object), q(r.to_object), q(r.kind), q(r.from_label), q(r.to_label),
    q(r.on_delete || 'restrict'), n(r.required), q(r.embed || 'ref'), j(r.display),
  ].join(',')});`);
});
out.push('');

menus.forEach((m) => {
  out.push(`INSERT INTO meta_menu (id,area,parent_id,label,icon,kind,target,roles,badge,sort,visible) VALUES (${[
    q(m.id), q(m.area), q(m.parent_id), q(m.label), q(m.icon), q(m.kind), q(m.target),
    j(m.roles), q(m.badge), n(m.sort), m.visible === 0 ? 0 : 1,
  ].join(',')});`);
});
out.push('');

// settings 與 line_command 已經有值時不覆蓋（秘書處可能改過文案）
settings.forEach((s, i) => {
  out.push(`INSERT OR IGNORE INTO settings ("key",group_name,type,value,help,sort,updated_at,updated_by) VALUES (${[
    q(s.key), q(s.group || '一般'), q(s.type || 'text'), q(s.value), q(s.help), (i + 1) * 10, q(now), q('seed'),
  ].join(',')});`);
});
out.push('');
lineCommands.forEach((c, i) => {
  out.push(`INSERT OR IGNORE INTO line_command (id,trigger_words,label,reply_template,handler,scope,roles,enabled,sort) VALUES (${[
    q(c.id), j(c.trigger), q(c.label), q(c.reply_template), q(c.handler), j(c.scope), j(c.roles), 1, (i + 1) * 10,
  ].join(',')});`);
});

const file = path.join(here, 'seed.sql');
fs.writeFileSync(file, out.join('\n') + '\n');
console.log('寫好', file);
console.log('物件', objects.length, '｜欄位', objects.reduce((t, o) => t + o.fields.length, 0), '｜關聯', relations.length, '｜選單', menus.length, '｜設定', settings.length, '｜LINE 指令', lineCommands.length);
