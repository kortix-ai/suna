// Agent avatar utility matching avocado branch implementation

export const getAgentAvatar = (agentId: string) => {
  const avatars = ['🤖', '🎯', '⚡', '🚀', '🔮', '🎨', '📊', '🔧', '💡', '🌟'];
  const colors = ['#06b6d4', '#22c55e', '#8b5cf6', '#3b82f6', '#ec4899', '#eab308', '#ef4444', '#6366f1'];
  const avatarIndex = agentId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % avatars.length;
  const colorIndex = agentId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  
  return {
    avatar: avatars[avatarIndex],
    color: colors[colorIndex]
  };
};