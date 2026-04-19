# Settings Component Architecture

## Visual Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Settings.tsx                             │
│              (Tab Navigation Container)                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │  │
│  │  │Providers│ │Gateway   │ │Allow/    │ │Detection│  │  │
│  │  │  Tab    │ │Key Tab   │ │Deny Lists│ │  Tab    │  │  │
│  │  └────────┘ └──────────┘ └──────────┘ └─────────┘  │  │
│  │                                                      │  │
│  │              (Component Router)                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Active Section Component                │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ Based on active tab
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Component Modules                          │
│                    (components/settings/)                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                 │
│  │ProvidersSection │  │GatewayKeySection│                 │
│  │  (174 lines)    │  │  (94 lines)     │                 │
│  │                 │  │                 │                 │
│  │ • Add Provider  │  │ • Generate Key  │                 │
│  │ • Remove Provider│ │ • Copy Key      │                 │
│  │ • List Providers│ │ • Display Keys  │                 │
│  └─────────────────┘  └─────────────────┘                 │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                 │
│  │  ListsSection   │  │DetectionSection │                 │
│  │  (122 lines)    │  │  (93 lines)     │                 │
│  │                 │  │                 │                 │
│  │ • Allow Rules   │  │ • PII Recognizer│                 │
│  │ • Deny Rules    │  │ • Clipboard     │                 │
│  │ • Rule CRUD     │  │   Monitoring    │                 │
│  └─────────────────┘  └─────────────────┘                 │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                 │
│  │BehaviorSection  │  │    RuleRow       │                 │
│  │  (100 lines)    │  │  (37 lines)      │                 │
│  │                 │  │                 │                 │
│  │ • Launch at Login│ │ • Toggle Enabled │                 │
│  │ • Minimize Tray │ │ • Show Pattern   │                 │
│  │ • Session Timeout│ │ • Remove Rule    │                 │
│  └─────────────────┘  └─────────────────┘                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ Shared styles & hooks
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Shared Resources                              │
├─────────────────────────────────────────────────────────────┤
│  • Settings.module.css (Styles)                             │
│  • useTauri hooks (Data access)                            │
│  • Lucide-react (Icons)                                     │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

```
User Action
    │
    ▼
┌─────────────────┐
│  Settings.tsx   │
│ (Tab Handler)  │
└────────┬────────┘
         │
         │ Renders active component
         ▼
┌─────────────────────────────┐
│  Section Component          │
│  (e.g., ProvidersSection)   │
└────────┬────────────────────┘
         │
         │ Uses hooks
         ▼
┌─────────────────────────────┐
│  Tauri Hooks                │
│  (useProviders, useSettings)│
└────────┬────────────────────┘
         │
         │ Manages State
         ▼
┌─────────────────────────────┐
│  Backend/Tauri IPC          │
└─────────────────────────────┘
```

## Component Hierarchy

```
Settings
├── Header (Title + Subtitle)
├── TabBar
│   ├── Providers Tab
│   ├── Gateway Key Tab
│   ├── Lists Tab
│   ├── Detection Tab
│   └── Behavior Tab
└── Tab Content
    ├── ProvidersSection (when active)
    │   ├── ProviderForm (inline)
    │   ├── ProviderCard (mapped)
    │   ├── TimeoutSelector (inline)
    │   └── NotificationToggle (inline)
    │
    ├── GatewayKeySection (when active)
    │   ├── KeyDisplay (mapped)
    │   └── CopyButton (inline)
    │
    ├── ListsSection (when active)
    │   ├── AllowList
    │   │   └── RuleRow (mapped)
    │   └── DenyList
    │       └── RuleRow (mapped)
    │
    ├── DetectionSection (when active)
    │   ├── RecognizerGrid (inline)
    │   └── ClipboardMonitorToggle (inline)
    │
    └── BehaviorSection (when active)
        └── ToggleSwitch (mapped)
```

## Key Design Decisions

### 1. Barrel Export Pattern
Used `index.ts` to provide a clean import interface:
```typescript
import {
  ProvidersSection,
  GatewayKeySection,
  ListsSection,
  DetectionSection,
  BehaviorSection,
} from "../components/settings";
```

### 2. Shared Styles
All components continue using `Settings.module.css` for consistency.

### 3. Hook-Based Data Access
Components directly use Tauri hooks (`useProviders`, `useSettings`, etc.) instead of prop drilling.

### 4. Inline vs Extracted Components
- **Extracted**: Full sections (ProvidersSection, etc.)
- **Inline**: Small reusable patterns within sections (forms, cards, buttons)

### 5. Type Safety
Each component exports its own types for better type checking and IDE support.

## Benefits Summary

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Main file lines | 658 | 54 | 92% reduction |
| Max file size | 658 | 174 | 74% reduction |
| Average file size | 658 | 96 | 85% reduction |
| Component cohesion | Low | High | ✅ |
| Code reusability | Low | High | ✅ |
| Maintainability | Difficult | Easy | ✅ |
