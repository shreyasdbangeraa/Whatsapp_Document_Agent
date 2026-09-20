create table if not exists bookmarks (
    id uuid default gen_random_uuid() primary key,
    user_id text not null,
    whatsapp_number text not null,
    url text not null,
    title text not null,
    summary text not null,
    category text default 'article',
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_bookmarks_user on bookmarks(whatsapp_number, created_at desc);
