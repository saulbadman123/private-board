-- Large paper: drawings may now be up to 1600 x 1200 pixels (Standard 1024 x 768 stays valid).
-- Additive and idempotent in effect: only the two dimension checks change, to a strictly wider range,
-- so every stored row still satisfies them and no published entry or Storage object is touched.
-- The 3 MiB image and bucket limits are unchanged. Run this BEFORE deploying a build that offers Large paper.
begin;
alter table public.entries drop constraint if exists entries_width_check;
alter table public.entries drop constraint if exists entries_height_check;
alter table public.entries add constraint entries_width_check check (width between 1 and 1600);
alter table public.entries add constraint entries_height_check check (height between 1 and 1200);
commit;
