BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('runId',id,'createdAt',created_at,'startedAt',started_at,'finishedAt',finished_at,'createdToFinishedMs',extract(epoch from finished_at-created_at)*1000,'startedToFinishedMs',extract(epoch from finished_at-started_at)*1000,'timeoutMs',CASE WHEN timeout_ms=180000 THEN 180000 END,'failed',status='failed','timedOut',status='timed_out') FROM runs WHERE id='256747aa-6298-4e4c-bc11-874ac38f3fd0';
COMMIT;
