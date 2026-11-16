-- name: get
SELECT
    id,
    created_at,
    updated_at,
    name,
    actions,
    visibility,
    visible_when,
    message_content,
    user_id,
    team_id,
    usage_count
FROM
    macros
WHERE
    id = $1;

-- name: get-all
SELECT
    id,
    created_at,
    updated_at,
    name,
    actions,
    visibility,
    visible_when,
    message_content,
    user_id,
    team_id,
    usage_count
FROM
    macros
ORDER BY
    updated_at DESC;

-- name: get-all-compact
SELECT
    COUNT(*) OVER() AS total,
    id,
    created_at,
    updated_at,
    name,
    actions,
    visibility,
    visible_when,
    message_content != '' AS has_message_content,
    user_id,
    team_id,
    usage_count
FROM macros
LEFT JOIN jsonb_array_elements_text(COALESCE(
    (SELECT value FROM settings WHERE key = 'macros.order'), '[]'::jsonb
)) WITH ORDINALITY AS macro_order(macro_id, position) ON macro_order.macro_id = macros.id::text
WHERE
    ($1 = '' OR name ILIKE $4 ESCAPE '\')
ORDER BY
    macro_order.position NULLS LAST,
    updated_at DESC,
    id DESC
LIMIT NULLIF($2, 0) OFFSET $3;

-- name: search-compact
SELECT
    id,
    created_at,
    updated_at,
    name,
    actions,
    visibility,
    visible_when,
    message_content != '' AS has_message_content,
    user_id,
    team_id,
    usage_count
FROM macros
LEFT JOIN jsonb_array_elements_text(COALESCE(
    (SELECT value FROM settings WHERE key = 'macros.order' AND $6::boolean), '[]'::jsonb
)) WITH ORDINALITY AS macro_order(macro_id, position) ON macro_order.macro_id = macros.id::text
WHERE
    ($1 = '' OR name ILIKE $5 ESCAPE '\')
    AND ($2 = '' OR $2 = ANY(visible_when::text[]))
    AND (NOT $6::boolean OR message_content != '')
    AND (
        visibility = 'all'
        OR (visibility = 'user' AND user_id = $3)
        OR (visibility = 'team' AND team_id = ANY($4::bigint[]))
    )
ORDER BY
    macro_order.position NULLS LAST,
    CASE WHEN NOT $6::boolean THEN usage_count END DESC,
    updated_at DESC,
    id DESC
LIMIT CASE WHEN $6::boolean THEN NULL ELSE 30 END;

-- name: set-order
INSERT INTO settings (key, value)
SELECT 'macros.order', COALESCE(jsonb_agg(macros.id ORDER BY requested.position), '[]'::jsonb)
FROM unnest($1::bigint[]) WITH ORDINALITY AS requested(macro_id, position)
JOIN macros ON macros.id = requested.macro_id
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- name: create
INSERT INTO
    macros (name, message_content, user_id, team_id, visibility, visible_when, actions)
VALUES
    ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: update
UPDATE
    macros
SET
    name = $2,
    message_content = $3,
    user_id = $4,
    team_id = $5,
    visibility = $6,
    visible_when = $7,
    actions = $8,
    updated_at = NOW()
WHERE
    id = $1
RETURNING *;

-- name: delete
DELETE FROM
    macros
WHERE
    id = $1;

-- name: increment-usage-count
UPDATE
    macros
SET
    usage_count = usage_count + 1
WHERE
    id = $1;
