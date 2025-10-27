import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';

interface CsvRendererProps {
  content: string;
  className?: string;
}

export function CsvRenderer({ content }: CsvRendererProps) {
  const processUnicodeContent = (text: string): string => {
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\r\\n/g, '\n')
      .replace(/\\r/g, '\n');
  };

  const parseCsv = (text: string): string[][] => {
    const lines = text.split('\n').filter(line => line.trim());
    const rows: string[][] = [];

    for (const line of lines) {
      const row: string[] = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          row.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }

      if (current || row.length > 0) {
        row.push(current.trim());
      }

      if (row.length > 0) {
        rows.push(row);
      }
    }

    return rows;
  };

  const processedContent = processUnicodeContent(content);
  const rows = parseCsv(processedContent);

  if (rows.length === 0) {
    return (
      <View className="items-center justify-center py-12">
        <Text className="text-sm font-roobert text-muted-foreground">
          No data to display
        </Text>
      </View>
    );
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const maxRows = 100;
  const displayRows = dataRows.slice(0, maxRows);
  const hasMore = dataRows.length > maxRows;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={true}>
      <ScrollView showsVerticalScrollIndicator={true} style={{ maxHeight: 400 }}>
        <View className="p-4">
          <View className="border border-border rounded-xl overflow-hidden">
            <View className="bg-muted/30 border-b-2 border-border flex-row">
              {headers.map((header, index) => (
                <View 
                  key={index} 
                  className="px-3 py-2 border-r border-border/50 min-w-[120px]"
                >
                  <Text className="text-xs font-roobert-semibold text-foreground">
                    {header || '-'}
                  </Text>
                </View>
              ))}
            </View>
            
            {displayRows.map((row, rowIndex) => (
              <View 
                key={rowIndex} 
                className={`flex-row ${rowIndex % 2 === 0 ? 'bg-background' : 'bg-muted/10'}`}
              >
                {headers.map((_, cellIndex) => (
                  <View 
                    key={cellIndex} 
                    className="px-3 py-2 border-r border-b border-border/30 min-w-[120px]"
                  >
                    <Text className="text-xs font-roobert text-foreground/80">
                      {row[cellIndex] || '-'}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
          
          {hasMore && (
            <View className="mt-3 items-center">
              <Text className="text-xs font-roobert text-muted-foreground">
                Showing {displayRows.length} of {dataRows.length} rows
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ScrollView>
  );
}
