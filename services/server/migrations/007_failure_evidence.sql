ALTER TABLE artifacts DROP CONSTRAINT artifacts_name_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_name_check CHECK (
    name IN ('report.html','results.json','author.json') OR
    name ~ '^data/[0-9a-f]{40}[.](png|zip|md)$'
);
