# Extending the Modular Prompt System

A guide for adding new capabilities to the modular prompt system using YAML configurations and structured JSON schemas.

## Overview

The modular prompt system uses three types of components to build agent prompts:

- **Configuration Files (YAML)**: Define agent identity, environment, and core principles
- **Tool Schemas (JSON)**: Define tool specifications with JSON Schema validation
- **Templates (YAML)**: Define context-specific instructions and workflows

## Directory Structure

```
prompts/
├── config/                 # YAML configuration files
│   ├── agent.yaml         # Agent identity and behavior
│   ├── environment.yaml   # Environment capabilities
│   └── system.yaml        # Main system configuration
│
├── schemas/                # JSON tool schemas
│   ├── design.json        # Design and image tools
│   ├── files.json         # File operation tools
│   ├── knowledge_base.json # Knowledge base tools
│   ├── web.json           # Web operation tools
│   └── agents.json        # Agent management tools
│
├── templates/              # YAML instruction templates
│   ├── base.yaml          # Base template (extended by others)
│   ├── files.yaml         # File operation instructions
│   ├── web.yaml           # Web development instructions
│   ├── browser.yaml       # Browser automation instructions
│   ├── design.yaml        # Design tool instructions
│   └── agents.yaml        # Agent management instructions
│
├── assembler.py           # Core assembly engine
└── prompt.py              # Main prompt module
```

## Adding Tool Schemas (JSON)

Tool schemas define available tools, their parameters, and usage guidelines.

### JSON Schema Structure

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Tool Category Name",
  "version": "1.0",
  "description": "Brief description of the tool category",

  "tools": [
    {
      "name": "tool_name",
      "description": "What the tool does",
      "priority": "when_to_use_this",

      "parameters": {
        "type": "object",
        "required": ["param1"],
        "properties": {
          "param1": {
            "type": "string",
            "description": "Parameter description"
          },
          "param2": {
            "type": "integer",
            "description": "Optional parameter",
            "default": 30
          }
        }
      },

      "critical_notes": [
        "Important warning or constraint",
        "Common mistake to avoid"
      ],

      "use_cases": [
        "Scenario where this tool is useful",
        "Another use case"
      ]
    }
  ],

  "best_practices": [
    "General guideline for this tool category",
    "Another best practice"
  ]
}
```

### Example: Database Tools Schema

Create `schemas/database.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Database Operations Tools",
  "version": "1.0",
  "description": "Tools for database operations and queries",

  "tools": [
    {
      "name": "execute_query",
      "description": "Execute SQL queries against the database",
      "priority": "use_for_data_operations",

      "parameters": {
        "type": "object",
        "required": ["query"],
        "properties": {
          "query": {
            "type": "string",
            "description": "SQL query to execute"
          },
          "database": {
            "type": "string",
            "description": "Database name (optional)",
            "default": "main"
          },
          "timeout": {
            "type": "integer",
            "description": "Query timeout in seconds",
            "default": 30
          }
        }
      },

      "critical_notes": [
        "Always validate SQL queries for syntax errors",
        "Use parameterized queries to prevent SQL injection",
        "Set appropriate timeouts for long-running queries"
      ],

      "use_cases": [
        "Data retrieval and analysis",
        "Database schema inspection",
        "Data manipulation and updates"
      ]
    },

    {
      "name": "list_tables",
      "description": "List all tables in the database",

      "parameters": {
        "type": "object",
        "properties": {
          "database": {
            "type": "string",
            "description": "Database name (optional)"
          }
        }
      }
    }
  ],

  "best_practices": [
    "Always use transactions for multiple related operations",
    "Test queries on small datasets first",
    "Handle connection errors gracefully"
  ]
}
```

### Using the New Schema

```python
from backend.core.prompts.prompt import get_custom_prompt

prompt = get_custom_prompt(
    include_tools=['database', 'files'],
    include_templates=['database']
)
```

## Adding Templates (YAML)

Templates define context-specific instructions, workflows, and critical rules.

### YAML Template Structure

```yaml
# Template Header
template:
  name: "template_name"
  extends: "base"                    # Optional: inherit from another template
  version: "1.0"

# Capabilities provided
capabilities:
  - capability_1
  - capability_2

# Critical rules
critical_rules:
  - rule: "Rule statement"
    reason: "Why this rule exists"
    example: "Optional example"

# Example workflows
example_workflows:
  workflow_name:
    - "Step 1"
    - "Step 2"
    - "Step 3"

# Best practices organized by category
best_practices:
  category_1:
    - "Practice 1"
    - "Practice 2"
  category_2:
    - "Practice 3"

# Patterns to follow or avoid
patterns:
  good:
    - "Good pattern 1"
    - "Good pattern 2"
  bad:
    - "Anti-pattern to avoid 1"
    - "Anti-pattern to avoid 2"

# Tool usage priority
tool_priority:
  primary: "main_tool"
  secondary: ["tool1", "tool2"]
  avoid: ["deprecated_tool"]
```

### Example: Database Operations Template

Create `templates/database.yaml`:

```yaml
# Database Operations Template
template:
  name: "database_operations"
  extends: "base"
  version: "1.0"

capabilities:
  - query_execution
  - schema_management
  - data_analysis
  - transaction_management

critical_rules:
  - rule: "ALWAYS use parameterized queries"
    reason: "Prevents SQL injection attacks"

  - rule: "Test queries on small datasets first"
    reason: "Avoids performance issues and long-running queries"

  - rule: "Use transactions for related operations"
    reason: "Ensures data consistency"

example_workflows:
  data_retrieval:
    - "Connect to the database using appropriate credentials"
    - "Execute SELECT query with appropriate filters"
    - "Process and format the results"
    - "Close the connection properly"

  schema_inspection:
    - "Use list_tables to see available tables"
    - "Use DESCRIBE or SHOW COLUMNS to inspect table structure"
    - "Document the schema for future reference"

  data_modification:
    - "Begin a transaction"
    - "Execute INSERT/UPDATE/DELETE queries"
    - "Validate the changes"
    - "Commit or rollback the transaction"

best_practices:
  performance:
    - "Use indexes for frequently queried columns"
    - "Avoid SELECT * in production queries"
    - "Use LIMIT for large result sets"

  security:
    - "Never concatenate user input into SQL strings"
    - "Use prepared statements or parameterized queries"
    - "Validate and sanitize all inputs"

  reliability:
    - "Set appropriate timeouts"
    - "Handle connection errors gracefully"
    - "Log all queries for debugging"

patterns:
  good:
    - "Using connection pooling for multiple queries"
    - "Implementing retry logic for transient failures"
    - "Using appropriate isolation levels"

  bad:
    - "Opening new connection for each query"
    - "Using string concatenation for queries"
    - "Ignoring transaction boundaries"

tool_priority:
  primary: "execute_query"
  secondary: ["list_tables", "describe_table"]
  avoid: []
```

## Adding Configuration Files (YAML)

Configuration files define core system properties, agent identity, and environment details.

### Configuration Structure

```yaml
# Configuration section
section_name:
  property_1: "value"
  property_2:
    - item_1
    - item_2

  nested_section:
    capability_1: true
    capability_2: false

# Lists of capabilities or limitations
capabilities:
  - "Capability description 1"
  - "Capability description 2"

limitations:
  - "Limitation description 1"
  - "Limitation description 2"
```

### Example: Database Configuration

Create `config/database_settings.yaml`:

```yaml
# Database Configuration
database:
  default_connection:
    type: "postgresql"
    host: "localhost"
    port: 5432

  capabilities:
    - "SQL queries"
    - "Transaction management"
    - "Schema inspection"

  limitations:
    - "Max query timeout: 300 seconds"
    - "Max result set: 10,000 rows"

  supported_databases:
    - postgresql
    - mysql
    - sqlite
    - mongodb

security:
  authentication: "required"
  encryption: "SSL/TLS"
  audit_logging: true
```

### Including in Main Configuration

Edit `config/system.yaml`:

```yaml
version: "2.0"

includes:
  - agent.yaml
  - environment.yaml
  - database_settings.yaml    # Add your new config

# Rest of system configuration...
```

## Usage Examples

### Get Complete System Prompt

```python
from backend.core.prompts.prompt import get_system_prompt

# Get the complete prompt with all capabilities
prompt = get_system_prompt()
```

### Get Custom Prompt with Specific Components

```python
from backend.core.prompts.prompt import get_custom_prompt

# Load only specific tools and templates
prompt = get_custom_prompt(
    include_tools=['database', 'files', 'web'],
    include_templates=['database', 'files']
)
```

### Get Agent Builder Prompt

```python
from backend.core.prompts.prompt import get_agent_builder_prompt

# Get specialized prompt for agent building
prompt = get_agent_builder_prompt()
```

## Best Practices

### 1. Keep It Modular

✅ **Good**: Separate concerns into different files
```
schemas/
  ├── database_read.json
  ├── database_write.json
  └── database_admin.json
```

❌ **Bad**: One massive file
```
schemas/
  └── everything.json
```

### 2. Use Descriptive Names

✅ **Good**: Clear, specific names
- `schemas/api_rest_operations.json`
- `templates/api_rest_workflows.yaml`

❌ **Bad**: Vague names
- `schemas/stuff.json`
- `templates/temp.yaml`

### 3. Follow Template Hierarchy

```yaml
template:
  name: "specific_feature"
  extends: "base"              # Inherit common rules

# Only add context-specific content
critical_rules:
  - rule: "Context-specific rule"
    reason: "Specific to this feature"
```

### 4. Document Thoroughly

```json
{
  "tools": [{
    "name": "tool_name",
    "description": "DETAILED description of what it does, when to use it",
    "critical_notes": [
      "Important warning or constraint",
      "Common mistake to avoid"
    ],
    "use_cases": [
      "Specific scenario 1",
      "Specific scenario 2"
    ]
  }]
}
```

### 5. Optimize for Token Efficiency

✅ **Concise but complete**:
```yaml
critical_rules:
  - rule: "Use transactions for multi-step operations"
    reason: "Ensures data consistency"
```

❌ **Verbose**:
```yaml
critical_rules:
  - rule: "You should always make sure to use database transactions whenever you are performing multiple operations that are related to each other..."
```

### 6. Use Includes for Reusability

```yaml
# config/common/error_handling.yaml
error_handling:
  strategy: "graceful_degradation"
  logging: true
  retry_logic:
    max_attempts: 3
    backoff: "exponential"

# Then include in multiple configs
# config/system.yaml
includes:
  - agent.yaml
  - environment.yaml
  - common/error_handling.yaml
```

### 7. Version Your Components

```json
{
  "title": "Database Tools",
  "version": "2.1",
  "changelog": {
    "2.1": "Added transaction support",
    "2.0": "Rewrote for efficiency",
    "1.0": "Initial release"
  }
}
```

## Complete Example: Adding Analytics Capability

### 1. Create Schema: `schemas/analytics.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Analytics Tools",
  "version": "1.0",
  "description": "Tools for data analytics and visualization",

  "tools": [
    {
      "name": "analyze_data",
      "description": "Perform statistical analysis on datasets",

      "parameters": {
        "type": "object",
        "required": ["data", "analysis_type"],
        "properties": {
          "data": {
            "type": "array",
            "description": "Dataset to analyze"
          },
          "analysis_type": {
            "type": "string",
            "enum": ["descriptive", "correlation", "regression"],
            "description": "Type of analysis to perform"
          }
        }
      },

      "critical_notes": [
        "Ensure data is clean and validated before analysis",
        "Handle missing values appropriately"
      ]
    },

    {
      "name": "create_visualization",
      "description": "Create charts and visualizations",

      "parameters": {
        "type": "object",
        "required": ["data", "chart_type"],
        "properties": {
          "data": {
            "type": "object",
            "description": "Data to visualize"
          },
          "chart_type": {
            "type": "string",
            "enum": ["bar", "line", "scatter", "pie"],
            "description": "Type of chart"
          }
        }
      }
    }
  ],

  "best_practices": [
    "Choose appropriate visualization types for data",
    "Label axes and provide legends",
    "Use color schemes that are accessible"
  ]
}
```

### 2. Create Template: `templates/analytics.yaml`

```yaml
template:
  name: "analytics_operations"
  extends: "base"
  version: "1.0"

capabilities:
  - statistical_analysis
  - data_visualization
  - trend_identification
  - report_generation

critical_rules:
  - rule: "Validate data quality before analysis"
    reason: "Poor data quality leads to incorrect insights"

  - rule: "Choose appropriate statistical methods"
    reason: "Different data types require different analyses"

  - rule: "Provide context with visualizations"
    reason: "Charts without context can be misleading"

example_workflows:
  exploratory_analysis:
    - "Load and inspect the dataset"
    - "Check for missing values and outliers"
    - "Perform descriptive statistics"
    - "Create visualizations to identify patterns"
    - "Document findings and insights"

  hypothesis_testing:
    - "Define null and alternative hypotheses"
    - "Choose appropriate statistical test"
    - "Check assumptions"
    - "Run the test and interpret p-values"
    - "Draw conclusions with confidence intervals"

best_practices:
  data_preparation:
    - "Handle missing values systematically"
    - "Remove or document outliers"
    - "Normalize or standardize when needed"

  analysis:
    - "Start with exploratory data analysis"
    - "Use multiple methods to validate findings"
    - "Consider statistical significance and practical significance"

  visualization:
    - "Choose chart types that match data structure"
    - "Use consistent color schemes"
    - "Provide clear labels and titles"
    - "Include data sources and timestamps"

patterns:
  good:
    - "Starting with summary statistics before complex analysis"
    - "Creating multiple views of the same data"
    - "Documenting assumptions and methodology"

  bad:
    - "Running analysis without understanding the data"
    - "Cherry-picking results that support hypotheses"
    - "Creating misleading visualizations"

tool_priority:
  primary: "analyze_data"
  secondary: ["create_visualization"]
  avoid: []
```

### 3. Create Configuration: `config/analytics_settings.yaml`

```yaml
analytics:
  supported_methods:
    descriptive:
      - mean
      - median
      - mode
      - standard_deviation

    inferential:
      - t_test
      - anova
      - chi_square
      - regression

  visualization:
    default_style: "modern"
    color_palette: "accessible"
    max_data_points: 10000

  constraints:
    - "Maximum dataset size: 1GB"
    - "Analysis timeout: 5 minutes"
    - "Visualization resolution: 4K max"
```

### 4. Include in System Config

```yaml
# config/system.yaml
version: "2.0"

includes:
  - agent.yaml
  - environment.yaml
  - analytics_settings.yaml
```

### 5. Use the New Capability

```python
from backend.core.prompts.prompt import get_custom_prompt

prompt = get_custom_prompt(
    include_tools=['analytics', 'files'],
    include_templates=['analytics']
)
```

## Summary

To extend the modular prompt system:

1. **Tool Schemas (JSON)**: Define tools with parameters in `schemas/`
2. **Templates (YAML)**: Define workflows and rules in `templates/`
3. **Configuration (YAML)**: Define settings in `config/` and include in `system.yaml`
4. **Use**: Reference in `get_custom_prompt()` to load your new capabilities

The system automatically loads and assembles components without code changes!