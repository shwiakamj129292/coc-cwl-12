-- Replace previously logged 24-byte hexadecimal admin bearer tokens.
UPDATE logs
SET token = '#ADMIN'
WHERE token IN (SELECT token FROM sessions)
   OR (
     length(token) = 48
     AND token NOT GLOB '*[^0-9a-fA-F]*'
   );
