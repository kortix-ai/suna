export default function fullInvitationUrl(token: string) {
  return `${process.env.NEXT_PUBLIC_URL}/invitation?token=${token}`;
}
