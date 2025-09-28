# Onboarding Components

A complete, refactored onboarding system with proper component organization and clean separation of concerns.

## 🗂️ Structure

```
onboarding/
├── index.ts                    # Main exports
├── onboarding-config.tsx       # Step definitions & navigation logic
├── new-onboarding-page.tsx     # Main onboarding page component
├── 
├── steps/                      # Individual step components
│   ├── ceo-intro-step.tsx
│   ├── smart-context-step.tsx
│   ├── workforce-selection-step.tsx
│   ├── team-invitation-step.tsx
│   └── completion-step.tsx
├── 
├── agent-config/               # Agent configuration components
│   ├── multi-agent-configuration.tsx
│   ├── agent-configuration.tsx
│   ├── field-renderer.tsx
│   └── configuration-utils.ts
├── 
└── shared/                     # Shared utilities & components
    ├── types.ts                # TypeScript interfaces
    ├── data.ts                 # Agent definitions & integrations
    ├── context.ts              # Global state management
    ├── step-wrapper.tsx        # Step layout wrapper
    ├── (uses UnifiedAgentCard)  # Agent selection via unified component
    └── progress-indicator.tsx  # Progress visualization
```

## 🚀 Usage

### Basic Usage

```tsx
import { NewOnboardingPage } from '@/components/onboarding';

function App() {
  return (
    <NewOnboardingPage
      onComplete={() => console.log('Onboarding completed!')}
      onClose={() => console.log('Onboarding closed')}
    />
  );
}
```

### Using Individual Steps

```tsx
import { CEOIntroStep, SmartContextStep } from '@/components/onboarding';

function CustomOnboarding() {
  return (
    <div>
      <CEOIntroStep />
      <SmartContextStep />
    </div>
  );
}
```

### Agent Configuration

```tsx
import { AgentConfiguration } from '@/components/onboarding';

function ConfigureAgent() {
  return (
    <AgentConfiguration
      agentId="maya"
      showHeader={true}
      onConfigurationChange={(agentId, config) => {
        console.log(`Agent ${agentId} configured:`, config);
      }}
    />
  );
}
```

## 🎯 Features

### ✨ Step Components

- **CEO Intro**: Welcome video and value propositions
- **Smart Context**: Intelligent user profiling and goal setting
- **Workforce Selection**: AI agent selection with smart recommendations
- **Agent Configuration**: Comprehensive agent customization
- **Team Invitation**: Collaborative workspace setup
- **Completion**: Success confirmation and next steps

### 🔧 Agent Configuration

- **Field Types**: Text, textarea, select, multiselect, integrations
- **Dynamic Forms**: Agent-specific configuration fields
- **Progress Tracking**: Visual completion indicators
- **Integration Setup**: Tool and platform connections

### 🎨 Shared Components

- **StepWrapper**: Consistent step layout with animations
- **AgentCard**: Interactive agent selection cards
- **ProgressIndicator**: Step progress visualization
- **FieldRenderer**: Dynamic form field rendering

### 📊 Data Management

- **Type Safety**: Comprehensive TypeScript interfaces
- **Agent Definitions**: Centralized agent data and capabilities
- **Integration Catalog**: Platform and tool definitions
- **Context Management**: Global onboarding state

## 🔄 State Management

The onboarding system uses a lightweight context system:

```tsx
import { userContext, updateUserContext } from '@/components/onboarding';

// Read current context
console.log(userContext.selectedAgents);

// Update context
updateUserContext({
  selectedAgents: ['maya', 'sage', 'nova'],
  userType: 'company'
});
```

## 🎮 Navigation & UX

### Keyboard Navigation
- `←` / `→` Arrow keys for step navigation
- Visual feedback for current step
- Smooth transitions between steps

### Progress Tracking
- Step-by-step progress indicator
- Completion percentage calculation
- Skip options for optional steps

### Validation
- Step-specific validation logic
- Contextual progression requirements
- Smart recommendations based on user input

## 🎨 Customization

### Adding New Steps

1. Create a new step component in `steps/`
2. Add to `onboardingSteps` in `onboarding-config.tsx`
3. Implement validation in `canProceedFromStep`

### Custom Agent Types

1. Add agent definition to `data.ts`
2. Create configuration fields in `configuration-utils.ts`
3. Add integrations to `integrationsByAgent`

### Styling

All components use Tailwind CSS with consistent design tokens:
- Primary colors for actions and highlights
- Muted colors for secondary information
- Smooth animations with framer-motion
- Responsive design patterns

## 🔧 Development

### Key Files to Modify

- **Add Steps**: `onboarding-config.tsx`
- **Agent Data**: `shared/data.ts`
- **Types**: `shared/types.ts`
- **Styling**: Individual component files
- **Validation**: `onboarding-config.tsx`

### Best Practices

1. **Component Isolation**: Each step is self-contained
2. **Type Safety**: Use TypeScript interfaces consistently
3. **Animation**: Consistent motion patterns with framer-motion
4. **Accessibility**: Keyboard navigation and ARIA labels
5. **Performance**: Lazy loading and optimized re-renders

## 🚀 Migration from Legacy

The old monolithic `onboarding-steps.tsx` has been completely refactored:

- ✅ **Before**: 1,400+ lines in single file
- ✅ **After**: Organized into logical component groups
- ✅ **Maintainability**: Easy to find and modify specific features
- ✅ **Reusability**: Components can be used independently
- ✅ **Type Safety**: Comprehensive TypeScript coverage
- ✅ **Performance**: Better tree-shaking and bundle optimization

## 📈 Performance Optimizations

- **Code Splitting**: Each step loads independently
- **Tree Shaking**: Only used components are bundled
- **Lazy Loading**: Steps load on demand
- **Memoization**: Optimized re-renders with React.memo
- **Bundle Size**: Reduced from monolithic to modular approach

