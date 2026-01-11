import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Table } from 'lucide-react-native';
import { log } from '@/lib/logger';

interface XlsxRendererProps {
  content: string;
  fileName?: string;
  className?: string;
}

export function XlsxRenderer({ content, fileName }: XlsxRendererProps) {
  // Handle empty or null content
  if (!content || typeof content !== 'string' || content.trim() === '') {
    return (
      <View className="flex-1 items-center justify-center py-16">
        <View className="bg-card rounded-2xl p-4 mb-4">
          <Icon as={Table} size={48} className="text-primary opacity-50" />
        </View>
        <Text className="text-lg font-roobert-semibold text-primary mb-2">
          No Data
        </Text>
        <Text className="text-sm font-roobert text-primary opacity-50 text-center px-8">
          This sheet appears to be empty.
        </Text>
      </View>
    );
  }

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
        <View className="bg-card rounded-2xl p-4 mb-4">
          <Icon as={Table} size={48} className="text-primary" />
        </View>
        <Text className="text-lg font-roobert-semibold text-primary mb-2">
          Excel File
        </Text>
        <Text className="text-sm font-roobert text-primary opacity-50 text-center px-8">
          {fileName || 'spreadsheet.xlsx'}
        </Text>
        <View className="bg-card rounded-lg px-4 py-2 mt-4 border border-border">
          <Text className="text-xs font-roobert text-primary opacity-50">
            Excel files cannot be previewed in mobile
          </Text>
        </View>
      </View>
    );
  }

  try {
    const data = JSON.parse(content);

    // Handle null or undefined data
    if (data == null) {
      return (
        <View className="flex-1 items-center justify-center py-16">
          <View className="bg-card rounded-2xl p-4 mb-4">
            <Icon as={Table} size={48} className="text-primary opacity-50" />
          </View>
          <Text className="text-lg font-roobert-semibold text-primary mb-2">
            No Data
          </Text>
          <Text className="text-sm font-roobert text-primary opacity-50 text-center px-8">
            This sheet appears to be empty.
          </Text>
        </View>
      );
    }

    if (Array.isArray(data)) {
      if (data.length === 0) {
        return (
          <View className="items-center justify-center py-12">
            <Text className="text-sm font-roobert text-primary opacity-50">
              Empty spreadsheet
            </Text>
          </View>
        );
      }

      // Find first non-null object to extract headers
      const firstRow = data.find((row) => row != null && typeof row === 'object');
      
      if (!firstRow) {
        return (
          <View className="items-center justify-center py-12">
            <Text className="text-sm font-roobert text-primary opacity-50">
              No valid data rows found
            </Text>
          </View>
        );
      }

      // Extract headers from first valid row
      const headers = Object.keys(firstRow).filter(key => firstRow[key] != null);
      
      // If no headers found, try to get all unique keys from all rows
      if (headers.length === 0) {
        const allKeys = new Set<string>();
        data.forEach((row) => {
          if (row != null && typeof row === 'object') {
            Object.keys(row).forEach(key => allKeys.add(key));
          }
        });
        if (allKeys.size === 0) {
          return (
            <View className="items-center justify-center py-12">
              <Text className="text-sm font-roobert text-primary opacity-50">
                No data to display
              </Text>
            </View>
          );
        }
      }

      // Filter out null/undefined rows and rows with no data
      const validRows = data.filter((row) => {
        if (row == null || typeof row !== 'object') return false;
        return Object.values(row).some(val => val != null && val !== '');
      });

      if (validRows.length === 0) {
        return (
          <View className="items-center justify-center py-12">
            <Text className="text-sm font-roobert text-primary opacity-50">
              No data to display
            </Text>
          </View>
        );
      }

      const maxRows = 100;
      const displayRows = validRows.slice(0, maxRows);
      const hasMore = validRows.length > maxRows;

      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
          <ScrollView showsVerticalScrollIndicator={true} style={{ maxHeight: 400 }}>
            <View className="p-4">
              <View className="border border-border rounded-xl overflow-hidden">
                {headers.length > 0 && (
                  <View className="bg-card border-b-2 border-border flex-row">
                    {headers.map((header, index) => (
                      <View
                        key={index}
                        className="px-3 py-2 border-r border-border min-w-[120px]"
                      >
                        <Text className="text-xs font-roobert-semibold text-primary">
                          {header}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {displayRows.map((row, rowIndex) => (
                  <View
                    key={rowIndex}
                    className={`flex-row ${rowIndex % 2 === 0 ? 'bg-background' : 'bg-card'}`}
                  >
                    {headers.map((header) => (
                      <View
                        key={header}
                        className="px-3 py-2 border-r border-b border-border min-w-[120px]"
                      >
                        <Text className="text-xs font-roobert text-primary">
                          {String(row[header] ?? '-')}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>

              {hasMore && (
                <View className="mt-3 items-center">
                  <Text className="text-xs font-roobert text-primary opacity-50">
                    Showing {displayRows.length} of {validRows.length} rows
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>
        </ScrollView>
      );
    }

    // Handle object data (non-array)
    if (typeof data === 'object') {
      return (
        <View className="p-4">
          <View className="bg-card border border-border rounded-xl p-4">
            <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
              <Text className="text-xs font-roobert-mono text-primary leading-5">
                {JSON.stringify(data, null, 2)}
              </Text>
            </ScrollView>
          </View>
        </View>
      );
    }

    // Fallback for other data types
    return (
      <View className="p-4">
        <View className="bg-card border border-border rounded-xl p-4">
          <Text className="text-sm font-roobert text-primary">
            {String(data)}
          </Text>
        </View>
      </View>
    );
  } catch (error) {
    log.error('[XlsxRenderer] Error parsing content:', error);
    return (
      <View className="flex-1 items-center justify-center py-16">
        <View className="bg-card rounded-2xl p-4 mb-4">
          <Icon as={Table} size={48} className="text-primary opacity-50" />
        </View>
        <Text className="text-lg font-roobert-semibold text-primary mb-2">
          Unable to Preview
        </Text>
        <Text className="text-sm font-roobert text-primary opacity-50 text-center px-8">
          This Excel file format is not supported for preview or contains unsupported data structures.
        </Text>
      </View>
    );
  }
}
