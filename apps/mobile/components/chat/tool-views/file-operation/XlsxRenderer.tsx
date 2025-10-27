import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Table } from 'lucide-react-native';

interface XlsxRendererProps {
  content: string;
  fileName?: string;
  className?: string;
}

export function XlsxRenderer({ content, fileName }: XlsxRendererProps) {
  const isBase64 = (str: string): boolean => {
    try {
      return btoa(atob(str)) === str;
    } catch (err) {
      return false;
    }
  };

  if (isBase64(content)) {
    return (
      <View className="flex-1 items-center justify-center py-16">
        <View className="bg-primary/10 rounded-2xl p-4 mb-4">
          <Icon as={Table} size={48} className="text-primary" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          Excel File
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center px-8">
          {fileName || 'spreadsheet.xlsx'}
        </Text>
        <View className="bg-muted/30 rounded-lg px-4 py-2 mt-4">
          <Text className="text-xs font-roobert text-foreground/60">
            Excel files cannot be previewed in mobile
          </Text>
        </View>
      </View>
    );
  }

  try {
    const data = JSON.parse(content);
    
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return (
          <View className="items-center justify-center py-12">
            <Text className="text-sm font-roobert text-muted-foreground">
              Empty spreadsheet
            </Text>
          </View>
        );
      }

      const headers = Object.keys(data[0]);
      const maxRows = 100;
      const displayRows = data.slice(0, maxRows);
      const hasMore = data.length > maxRows;

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
                        {header}
                      </Text>
                    </View>
                  ))}
                </View>
                
                {displayRows.map((row, rowIndex) => (
                  <View 
                    key={rowIndex} 
                    className={`flex-row ${rowIndex % 2 === 0 ? 'bg-background' : 'bg-muted/10'}`}
                  >
                    {headers.map((header) => (
                      <View 
                        key={header} 
                        className="px-3 py-2 border-r border-b border-border/30 min-w-[120px]"
                      >
                        <Text className="text-xs font-roobert text-foreground/80">
                          {String(row[header] ?? '-')}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
              
              {hasMore && (
                <View className="mt-3 items-center">
                  <Text className="text-xs font-roobert text-muted-foreground">
                    Showing {displayRows.length} of {data.length} rows
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>
        </ScrollView>
      );
    }

    return (
      <View className="p-4">
        <View className="bg-muted/20 border border-border rounded-xl p-4">
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
            <Text className="text-xs font-mono text-foreground/80 leading-5">
              {JSON.stringify(data, null, 2)}
            </Text>
          </ScrollView>
        </View>
      </View>
    );
  } catch (error) {
    return (
      <View className="flex-1 items-center justify-center py-16">
        <View className="bg-muted/30 rounded-2xl p-4 mb-4">
          <Icon as={Table} size={48} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          Unable to Preview
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center px-8">
          This Excel file format is not supported for preview
        </Text>
      </View>
    );
  }
}
