# Agent Profile Card Components

A collection of stunning profile card components that combine beautiful holographic visual effects with comprehensive agent management functionality.

## Components

### `AgentProfileCard`

A next-generation agent card component that extends the original ProfileCard with agent-specific functionality while maintaining all the beautiful visual effects.

#### Features

- 🎨 **Stunning Visual Effects**
  - Interactive 3D tilt animations
  - Holographic background gradients
  - Dynamic lighting and shine effects
  - Smooth hover transitions
  - Customizable color schemes

- ⚡ **Comprehensive Functionality**
  - Multiple display modes (Library, Marketplace, Preview)
  - Agent management actions (Chat, Customize, Delete, etc.)
  - Detailed modal dialogs with agent information
  - Loading states with visual feedback
  - Responsive design for all screen sizes

- 🤖 **Agent-Specific Features**
  - Agent avatar with custom colors
  - Tool and MCP integration display
  - Knowledge base indicators
  - Status badges (Default, Public, Managed)
  - Marketplace statistics (downloads, ratings)
  - Tag system support
  - Creator information display

#### Usage

```tsx
import { AgentProfileCard } from '@/components/ProfileCard';

const MyComponent = () => {
  const handleChat = (agentId: string) => {
    // Navigate to chat with this agent
    router.push(`/chat?agent=${agentId}`);
  };

  const handleCustomize = (agentId: string) => {
    // Open agent customization
    router.push(`/agents/edit/${agentId}`);
  };

  return (
    <AgentProfileCard
      agent={agentData}
      mode="library"
      onChat={handleChat}
      onCustomize={handleCustomize}
      onDelete={handleDelete}
      enableTilt={true}
      showActions={true}
    />
  );
};
```

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `agent` | `Agent` | **required** | Agent data object |
| `mode` | `'library' \| 'marketplace' \| 'preview'` | `'library'` | Display mode affecting available actions |
| `className` | `string` | `''` | Additional CSS classes |
| `style` | `React.CSSProperties` | `undefined` | Inline styles |
| `enableTilt` | `boolean` | `true` | Enable 3D tilt animations |
| `onChat` | `(agentId: string) => void` | `undefined` | Chat button handler |
| `onCustomize` | `(agentId: string) => void` | `undefined` | Customize button handler |
| `onDelete` | `(agentId: string) => void` | `undefined` | Delete button handler |
| `onAddToLibrary` | `(agentId: string) => void` | `undefined` | Add to library handler (marketplace mode) |
| `onPreview` | `(agentId: string) => void` | `undefined` | Preview handler |
| `isLoading` | `boolean` | `false` | Show loading state |
| `loadingAction` | `string` | `''` | Loading message |
| `showActions` | `boolean` | `true` | Show action buttons |
| `compact` | `boolean` | `false` | Use compact size |

#### Agent Data Interface

```typescript
interface Agent {
  agent_id: string;
  account_id: string;
  name: string;
  description?: string;
  system_prompt: string;
  configured_mcps: Array<{ name: string; [key: string]: any }>;
  custom_mcps?: Array<{ name: string; [key: string]: any }>;
  agentpress_tools: Record<string, any>;
  is_default: boolean;
  is_public?: boolean;
  is_managed?: boolean;
  is_owned?: boolean;
  visibility?: 'public' | 'teams' | 'private';
  knowledge_bases?: Array<{ [key: string]: any }>;
  marketplace_published_at?: string;
  download_count?: number;
  tags?: string[];
  sharing_preferences?: {
    managed_agent?: boolean;
    [key: string]: any;
  };
  avatar?: string;
  avatar_color?: string;
  created_at: string;
  updated_at: string;
  creator_name?: string;
}
```

### Display Modes

#### Library Mode
- **Purpose**: Personal agent collection management
- **Actions**: Chat, Customize, Delete, Toggle Default
- **Features**: Full management capabilities, status indicators
- **Best for**: Agents, personal workspace

#### Marketplace Mode
- **Purpose**: Browse and download public agents
- **Actions**: Add to Library, Preview
- **Features**: Download counts, creator info, managed agent indicators
- **Best for**: Agent marketplace, community sharing

#### Preview Mode
- **Purpose**: Quick browsing and selection
- **Actions**: Preview/Select
- **Features**: Compact layout, minimal actions
- **Best for**: Agent selection dialogs, quick previews

### `AgentProfileCardDemo`

A comprehensive demo component showcasing all the features and modes of the AgentProfileCard.

```tsx
import { AgentProfileCardDemo } from '@/components/ProfileCard';

// Use in a page or component to see the demo
<AgentProfileCardDemo />
```

### Original `ProfileCard`

The original ProfileCard component is still available for general profile use cases.

```tsx
import { ProfileCard } from '@/components/ProfileCard';

<ProfileCard
  avatarUrl="/avatar.jpg"
  name="John Doe"
  title="Software Engineer"
  handle="johndoe"
  status="Online"
  onContactClick={handleContact}
/>
```

## Visual Effects

The components use advanced CSS animations and transforms to create:

- **3D Tilt Effect**: Cards tilt based on mouse position
- **Holographic Backgrounds**: Shifting gradient overlays
- **Dynamic Lighting**: Light effects that follow the cursor
- **Shine Animation**: Animated holographic shine patterns
- **Smooth Transitions**: Fluid animations between states

## Responsive Design

All components are fully responsive with breakpoints for:
- Mobile (< 480px)
- Tablet (< 768px)
- Desktop (> 768px)

## Accessibility

- Proper ARIA labels and roles
- Keyboard navigation support
- Screen reader friendly
- High contrast support
- Focus management

## Browser Support

- Modern browsers with CSS custom properties support
- Chrome 49+
- Firefox 31+
- Safari 9.1+
- Edge 16+

## Performance

- Optimized animations using `transform` and `opacity`
- Hardware acceleration enabled
- Efficient re-renders with React.memo patterns
- Minimal bundle impact with tree-shaking support

## Examples

### Replace Existing Agent Cards

```tsx
// Before: Using basic agent cards
<div className="grid grid-cols-3 gap-4">
  {agents.map(agent => (
    <div key={agent.id} className="border rounded p-4">
      <h3>{agent.name}</h3>
      <p>{agent.description}</p>
      <button onClick={() => chat(agent.id)}>Chat</button>
    </div>
  ))}
</div>

// After: Using AgentProfileCard
<div className="grid grid-cols-3 gap-8">
  {agents.map(agent => (
    <AgentProfileCard
      key={agent.agent_id}
      agent={agent}
      mode="library"
      onChat={chat}
      onCustomize={customize}
      onDelete={deleteAgent}
      enableTilt={true}
    />
  ))}
</div>
```

### Marketplace Integration

```tsx
const MarketplacePage = () => {
  const { data: agents } = useMarketplaceAgents();
  
  return (
    <div className="container mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {agents?.map(agent => (
          <AgentProfileCard
            key={agent.agent_id}
            agent={agent}
            mode="marketplace"
            onAddToLibrary={addToLibrary}
            isLoading={loadingAgent === agent.agent_id}
            loadingAction="Adding to library..."
          />
        ))}
      </div>
    </div>
  );
};
```

### Custom Styling

```tsx
<AgentProfileCard
  agent={agent}
  className="custom-agent-card"
  style={{
    '--card-radius': '20px',
    '--sunpillar-1': '#ff6b6b',
    '--sunpillar-2': '#4ecdc4',
  } as React.CSSProperties}
  enableTilt={true}
/>
```

## CSS Custom Properties

You can customize the visual effects using CSS custom properties:

```css
.custom-agent-card {
  --card-radius: 30px;
  --sunpillar-1: hsl(2, 100%, 73%);
  --sunpillar-2: hsl(53, 100%, 69%);
  --sunpillar-3: hsl(93, 100%, 69%);
  --sunpillar-4: hsl(176, 100%, 76%);
  --sunpillar-5: hsl(228, 100%, 74%);
  --sunpillar-6: hsl(283, 100%, 73%);
}
```

## Integration Tips

1. **Performance**: Use `React.memo` when rendering many cards
2. **Loading States**: Always provide loading feedback for async actions
3. **Error Handling**: Implement proper error boundaries
4. **Accessibility**: Test with screen readers and keyboard navigation
5. **Mobile**: Test touch interactions on mobile devices
6. **Data**: Ensure agent data is properly typed and validated

## Migration Guide

### From AgentsGrid Component

```tsx
// Old AgentsGrid usage
<AgentsGrid
  agents={agents}
  onEditAgent={handleEdit}
  onDeleteAgent={handleDelete}
  onChat={handleChat}
/>

// New AgentProfileCard usage
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
  {agents.map(agent => (
    <AgentProfileCard
      key={agent.agent_id}
      agent={agent}
      mode="library"
      onCustomize={handleEdit}
      onDelete={handleDelete}
      onChat={handleChat}
      enableTilt={true}
    />
  ))}
</div>
```

### From Marketplace Cards

```tsx
// Old marketplace cards
{agents.map(agent => (
  <MarketplaceCard
    key={agent.id}
    agent={agent}
    onAddToLibrary={addToLibrary}
  />
))}

// New AgentProfileCard
{agents.map(agent => (
  <AgentProfileCard
    key={agent.agent_id}
    agent={agent}
    mode="marketplace"
    onAddToLibrary={addToLibrary}
    enableTilt={true}
  />
))}
``` 