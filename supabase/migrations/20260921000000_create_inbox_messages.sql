create table if not exists inbox_messages (
    id uuid default gen_random_uuid() primary key,
    sender_phone text not null,
    sender_name text,
    message_id text,
    message_type text not null default 'text',
    content text,
    is_read_by_owner boolean default false,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_inbox_sender_name on inbox_messages(sender_name, created_at desc);
create index if not exists idx_inbox_sender_phone on inbox_messages(sender_phone, created_at desc);
create index if not exists idx_inbox_unread on inbox_messages(is_read_by_owner, created_at desc);
