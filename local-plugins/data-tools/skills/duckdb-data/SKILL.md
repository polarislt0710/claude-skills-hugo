---
name: duckdb-data
description: High-performance in-process data analysis using DuckDB. Use for SQL-based analysis on CSV, Parquet, JSON files, large dataset queries, data transformation, and exploratory data analysis. Triggers when user wants to analyze data files, write analytical SQL, join multiple datasets, run aggregations, export processed data, or when DuckDB/data analysis is mentioned. Much faster than pandas for large files — use DuckDB first for any tabular data work.
---

# DuckDB Data Analysis Skill

Inspired by: https://github.com/duckdb/duckdb

## Why DuckDB
- Runs in-process (no server needed)
- Reads CSV/Parquet/JSON directly
- SQL-native: no ORM, just pure SQL
- Faster than pandas for analytical queries
- Supports Arrow, pandas interop

## Setup
```python
import duckdb
con = duckdb.connect()  # in-memory
# or: con = duckdb.connect('mydb.duckdb')  # persistent
```

## Core Patterns

### Read Files Directly
```sql
-- CSV (auto-detect schema)
SELECT * FROM read_csv_auto('data.csv') LIMIT 5;

-- Parquet
SELECT * FROM read_parquet('data.parquet');

-- Multiple files
SELECT * FROM read_csv_auto('data/*.csv');

-- JSON
SELECT * FROM read_json_auto('data.json');
```

### Exploratory Analysis
```sql
-- Quick schema inspection
DESCRIBE SELECT * FROM read_csv_auto('file.csv');

-- Summary statistics
SUMMARIZE SELECT * FROM read_csv_auto('file.csv');

-- Value distribution
SELECT column_name, COUNT(*) as n, COUNT(DISTINCT column_name) as unique_vals
FROM read_csv_auto('file.csv')
GROUP BY 1;

-- Null counts
SELECT COUNT(*) - COUNT(col1) as nulls_col1 FROM data;
```

### Data Transformation
```sql
-- Create table from file
CREATE TABLE sales AS SELECT * FROM read_csv_auto('sales.csv');

-- Add computed columns
SELECT *,
  revenue - cost AS profit,
  ROUND(revenue / SUM(revenue) OVER () * 100, 2) AS pct_of_total
FROM sales;

-- Date operations
SELECT
  DATE_TRUNC('month', order_date) AS month,
  SUM(amount) AS monthly_revenue
FROM orders
GROUP BY 1
ORDER BY 1;
```

### Window Functions
```sql
-- Running total
SELECT date, amount,
  SUM(amount) OVER (ORDER BY date) AS running_total

-- Rank within group
SELECT product, category, sales,
  RANK() OVER (PARTITION BY category ORDER BY sales DESC) AS rank_in_cat

-- Previous period comparison
SELECT date, revenue,
  LAG(revenue, 1) OVER (ORDER BY date) AS prev_period,
  revenue - LAG(revenue, 1) OVER (ORDER BY date) AS change
FROM monthly_revenue;
```

### Export Results
```sql
-- Export to CSV
COPY (SELECT * FROM results) TO 'output.csv' (HEADER, DELIMITER ',');

-- Export to Parquet
COPY results TO 'output.parquet' (FORMAT PARQUET);

-- Export to JSON
COPY results TO 'output.json';
```

### Pandas Integration
```python
import duckdb, pandas as pd

df = pd.read_csv('data.csv')
# Query pandas df directly!
result = duckdb.query("SELECT category, SUM(amount) FROM df GROUP BY 1").df()
```

## Analysis Workflow

1. **Load & Inspect**: `DESCRIBE` + `SUMMARIZE` → understand schema
2. **Clean**: Handle nulls, fix types, normalize strings
3. **Transform**: JOINs, aggregations, window functions
4. **Validate**: Row count checks, range validation, spot checks
5. **Export**: To CSV/Parquet/pandas for downstream use

## Common Analytical Queries

### Cohort Analysis
```sql
SELECT
  DATE_TRUNC('month', first_purchase) AS cohort,
  DATE_DIFF('month', first_purchase, order_date) AS months_since,
  COUNT(DISTINCT user_id) AS users
FROM orders o
JOIN (SELECT user_id, MIN(order_date) AS first_purchase FROM orders GROUP BY 1) f
  USING (user_id)
GROUP BY 1, 2;
```

### Funnel Analysis
```sql
SELECT
  COUNT_IF(step = 'view') AS views,
  COUNT_IF(step = 'add_cart') AS add_to_cart,
  COUNT_IF(step = 'purchase') AS purchases,
  COUNT_IF(step = 'purchase') * 100.0 / COUNT_IF(step = 'view') AS conversion_rate
FROM events;
```
