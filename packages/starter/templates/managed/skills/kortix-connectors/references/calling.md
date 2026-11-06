# Calling connectors: paging, attachments, GraphQL

## Paging

Page through everything only when the human needs every record. Write one
file per page and merge once at the end. Take the cursor field names from
the shape `--out` printed:

```sh
i=1; cursor=""
while :; do
  args=$([ -z "$cursor" ] && echo '{"first":250}' || echo "{\"first\":250,\"after\":\"$cursor\"}")
  kortix connectors call <slug> <list_action> "$args" --account "<label>" --out /tmp/page$i.json >/dev/null || break
  [ "$(jq -r '.data.result.page_info.hasNextPage' /tmp/page$i.json)" = true ] || break
  cursor=$(jq -r '.data.result.page_info.endCursor' /tmp/page$i.json); i=$((i+1))
done
jq -s '[.[].data.result.issues[]]' /tmp/page*.json > /tmp/all.json
```

`call` exits 1 on a denial or a `tool_error`, so `|| break` also stops the
loop on a failed page. Read that page's file before you retry.

## Attachments

Write the file under `/workspace/artifacts` (or `output`, `reports`,
`deliverables`), put the JSON args in a file, and pass `--attach`. The CLI
stages the raw bytes and the gateway builds the provider's attachment item
(Microsoft Graph, SendGrid, Postmark, Mailjet, Resend, Brevo, and the Email
channel):

```sh
cat > /tmp/mail.json <<'JSON'
{"user":"sender@example.com","body":{"message":{"subject":"Report",
 "body":{"contentType":"Text","content":"Attached."},
 "toRecipients":[{"emailAddress":{"address":"to@example.com"}}]},
 "saveToSentItems":true}}
JSON
kortix connectors call microsoft-graph sendmail @/tmp/mail.json \
  --attach /workspace/artifacts/report.pdf
```

Leave the attachments array out of the JSON: `--attach` appends to it. When
the CLI cannot find the field, pass `--attach-path <a.b.c>`, or run
`kortix connectors upload <file> --connector <slug>` and put the printed
`ref` (`{"$kortix_attachment":"<id>"}`) where the file belongs: in an
`attachments` array, or as the value of a base64 field such as
`contentBytes`. Pass the body as a JSON object, never as a string. Never put
base64 in args yourself.

## Videos to YouTube

A video in the session goes to YouTube in two steps, at any size. Never use
`multipart_upload_video` for a file in the session: it needs a public URL and
stops at 100 MB.

```sh
F=/workspace/output/video.mp4
jq -n --arg file "$F" --argjson size "$(stat -c %s "$F")" \
  '{title:"Launch demo", privacy_status:"private", file_path:$file, file_size:$size, mime_type:"video/mp4"}' \
  > /tmp/yt-args.json
kortix connectors call youtube upload_video @/tmp/yt-args.json --out /tmp/yt-upload.json
bash -c "$(jq -r '.data.result.caller_only.upload_command' /tmp/yt-upload.json)"
```

Build the args with `jq --arg`, never by pasting a path into a JSON string: a
quote in a file name would add fields. The `curl` prints the video JSON:
`id` is the video, `https://youtu.be/<id>`. Upload as `private` unless the
human chose otherwise. YouTube processes the video after the upload. If
`curl` breaks, run `caller_only.resume_status_command`: HTTP 308 with
`Range: bytes=0-N` means send the rest from byte N+1. The upload URL is a
credential for this one video: never paste it into chat, a file or a commit.
After an approval, the resume prompt carries `caller_only`.

`upstream_429` with `rateLimitExceeded` means the Google app the account
signed in with has used its uploads for today; Google counts uploads per app,
not per channel. Retry once after `retry_after_seconds` (the reset at midnight
Pacific time): every earlier retry fails. Tell the human the time, and that
YouTube Studio uploads do not count against it. `uploadLimitExceeded` is the
channel's own daily limit: retry in 24 hours.

## GraphQL field selection

Put the selected fields in `args.__select`:

```sh
kortix connectors call internal_graph query.user \
  '{"id":"1","__select":"id name email"}'
```

## Large results

Tool output above ~50 KB is truncated in your context. `--out <file>` writes
the whole result and prints only `saved_to`, `bytes` and `shape`. Query the
file with `jq` or `bun`, never `cat`.
