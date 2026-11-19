ALTER TABLE tests ADD COLUMN deleted_at timestamptz;

UPDATE tests t SET deleted_at=COALESCE(closed.last_closed, now())
FROM (
    SELECT test_id,max(closed_at) AS last_closed FROM editing_sessions
    GROUP BY test_id HAVING bool_and(status='discarded')
) closed
WHERE t.id=closed.test_id AND t.kind='test' AND t.published_version_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM test_versions v WHERE v.test_id=t.id);
