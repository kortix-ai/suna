import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Colors } from '../../constants/Colors';
import { useColorScheme } from '../../hooks/useColorScheme';

interface CsvRendererProps {
    content: string;
    style?: any;
}

type SortDirection = 'asc' | 'desc' | null;

interface SortConfig {
    column: string;
    direction: SortDirection;
}

function parseCSV(content: string) {
    if (!content) return { data: [], headers: [], meta: null };

    try {
        // Simple CSV parser for React Native
        const lines = content.split('\n').filter(line => line.trim());
        if (lines.length === 0) return { data: [], headers: [], meta: null };

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const data = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
            const row: any = {};
            headers.forEach((header, index) => {
                const value = values[index] || '';
                // Try to parse as number
                const numValue = parseFloat(value);
                row[header] = !isNaN(numValue) && value !== '' ? numValue : value;
            });
            return row;
        });

        return { headers, data, meta: null };
    } catch (error) {
        console.error("Error parsing CSV:", error);
        return { headers: [], data: [], meta: null };
    }
}

export function CsvRenderer({ content, style }: CsvRendererProps) {
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';
    const theme = Colors[colorScheme ?? 'light'];

    const [searchTerm, setSearchTerm] = useState('');
    const [sortConfig, setSortConfig] = useState<SortConfig>({ column: '', direction: null });
    const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = useState(1);
    const [showColumnFilter, setShowColumnFilter] = useState(false);
    const rowsPerPage = 50;

    const parsedData = parseCSV(content);
    const isEmpty = parsedData.data.length === 0;

    const processedData = useMemo(() => {
        let filtered = parsedData.data;

        if (searchTerm) {
            filtered = filtered.filter((row: any) =>
                Object.values(row).some(value =>
                    String(value).toLowerCase().includes(searchTerm.toLowerCase())
                )
            );
        }

        if (sortConfig.column && sortConfig.direction) {
            filtered = [...filtered].sort((a: any, b: any) => {
                const aVal = a[sortConfig.column];
                const bVal = b[sortConfig.column];

                if (aVal == null && bVal == null) return 0;
                if (aVal == null) return sortConfig.direction === 'asc' ? -1 : 1;
                if (bVal == null) return sortConfig.direction === 'asc' ? 1 : -1;

                if (typeof aVal === 'number' && typeof bVal === 'number') {
                    return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
                }

                const aStr = String(aVal).toLowerCase();
                const bStr = String(bVal).toLowerCase();

                if (aStr < bStr) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aStr > bStr) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return filtered;
    }, [parsedData.data, searchTerm, sortConfig]);

    const totalPages = Math.ceil(processedData.length / rowsPerPage);
    const startIndex = (currentPage - 1) * rowsPerPage;
    const paginatedData = processedData.slice(startIndex, startIndex + rowsPerPage);

    const visibleHeaders = parsedData.headers.filter(header => !hiddenColumns.has(header));

    const handleSort = (column: string) => {
        setSortConfig(prev => {
            if (prev.column === column) {
                const newDirection = prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc';
                return { column: newDirection ? column : '', direction: newDirection };
            } else {
                return { column, direction: 'asc' };
            }
        });
    };

    const toggleColumnVisibility = (column: string) => {
        setHiddenColumns(prev => {
            const newSet = new Set(prev);
            if (newSet.has(column)) {
                newSet.delete(column);
            } else {
                newSet.add(column);
            }
            return newSet;
        });
    };

    const getSortIcon = (column: string) => {
        if (sortConfig.column !== column) {
            return 'swap-vertical';
        }
        return sortConfig.direction === 'asc' ? 'chevron-up' : 'chevron-down';
    };

    const formatCellValue = (value: any) => {
        if (value == null) return '';
        if (typeof value === 'number') {
            return value.toLocaleString();
        }
        if (typeof value === 'boolean') {
            return value ? 'Yes' : 'No';
        }
        return String(value);
    };

    const getCellStyle = (value: any) => {
        if (typeof value === 'number') {
            return { textAlign: 'right' as const, fontFamily: 'monospace' };
        }
        if (typeof value === 'boolean') {
            return { color: value ? '#22c55e' : '#ef4444' };
        }
        return {};
    };

    if (isEmpty) {
        return (
            <View style={[{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: theme.background,
                padding: 20
            }, style]}>
                <View style={{
                    alignItems: 'center',
                    backgroundColor: isDark ? '#333' : '#f5f5f5',
                    padding: 20,
                    borderRadius: 10
                }}>
                    <Ionicons name="document-text-outline" size={48} color={theme.foreground} style={{ marginBottom: 16 }} />
                    <Text style={{ fontSize: 18, fontWeight: '600', color: theme.foreground, marginBottom: 8 }}>
                        No Data
                    </Text>
                    <Text style={{ fontSize: 14, color: theme.foreground, opacity: 0.7 }}>
                        This CSV file appears to be empty or invalid.
                    </Text>
                </View>
            </View>
        );
    }

    // Create table data with header row
    const tableData = [
        { type: 'header', data: visibleHeaders },
        ...paginatedData.map((row, index) => ({ type: 'row', data: row, index }))
    ];

    const renderTableRow = ({ item }: { item: any }) => {
        if (item.type === 'header') {
            return (
                <View style={{
                    flexDirection: 'row',
                    backgroundColor: isDark ? '#333' : '#f8f9fa',
                    borderBottomWidth: 1,
                    borderBottomColor: isDark ? '#404040' : '#e9ecef',
                    paddingVertical: 12
                }}>
                    {item.data.map((header: string, index: number) => (
                        <TouchableOpacity
                            key={header}
                            onPress={() => handleSort(header)}
                            style={{
                                width: 150,
                                flexDirection: 'row',
                                alignItems: 'center',
                                paddingHorizontal: 12,
                                borderRightWidth: index < item.data.length - 1 ? 1 : 0,
                                borderRightColor: isDark ? '#404040' : '#e9ecef'
                            }}
                        >
                            <Text style={{
                                fontSize: 14,
                                fontWeight: '600',
                                color: theme.foreground,
                                flex: 1
                            }} numberOfLines={1}>
                                {header}
                            </Text>
                            <Ionicons
                                name={getSortIcon(header)}
                                size={16}
                                color={sortConfig.column === header ? '#007AFF' : theme.foreground}
                                style={{ opacity: sortConfig.column === header ? 1 : 0.5 }}
                            />
                        </TouchableOpacity>
                    ))}
                </View>
            );
        }

        return (
            <View style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: isDark ? '#404040' : '#e9ecef',
                paddingVertical: 12,
                backgroundColor: item.index % 2 === 0 ? 'transparent' : (isDark ? '#2a2a2a' : '#f8f9fa')
            }}>
                {visibleHeaders.map((header, cellIndex) => {
                    const value = item.data[header];
                    const cellStyle = getCellStyle(value);
                    return (
                        <View
                            key={`${startIndex + item.index}-${cellIndex}`}
                            style={{
                                width: 150,
                                paddingHorizontal: 12,
                                justifyContent: 'center',
                                borderRightWidth: cellIndex < visibleHeaders.length - 1 ? 1 : 0,
                                borderRightColor: isDark ? '#404040' : '#e9ecef'
                            }}
                        >
                            <Text style={{
                                fontSize: 12,
                                color: cellStyle.color || theme.foreground,
                                fontFamily: cellStyle.fontFamily || undefined,
                                textAlign: cellStyle.textAlign || 'left'
                            }} numberOfLines={2}>
                                {formatCellValue(value)}
                            </Text>
                        </View>
                    );
                })}
            </View>
        );
    };

    return (
        <View style={[{ flex: 1, backgroundColor: theme.background }, style]}>
            {/* Header */}
            <View style={{
                backgroundColor: isDark ? '#2a2a2a' : '#f8f9fa',
                borderBottomWidth: 1,
                borderBottomColor: isDark ? '#404040' : '#e9ecef',
                paddingHorizontal: 16,
                paddingVertical: 12
            }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Ionicons name="grid-outline" size={20} color={theme.foreground} style={{ marginRight: 8 }} />
                        <Text style={{ fontSize: 16, fontWeight: '600', color: theme.foreground }}>CSV Data</Text>
                        <View style={{ backgroundColor: isDark ? '#404040' : '#e9ecef', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginLeft: 8 }}>
                            <Text style={{ fontSize: 12, color: theme.foreground }}>
                                Page {currentPage} of {totalPages}
                            </Text>
                        </View>
                    </View>

                    <TouchableOpacity
                        onPress={() => setShowColumnFilter(!showColumnFilter)}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            backgroundColor: isDark ? '#404040' : '#e9ecef',
                            borderRadius: 6
                        }}
                    >
                        <Ionicons name="filter-outline" size={16} color={theme.foreground} />
                        <Text style={{ fontSize: 12, color: theme.foreground, marginLeft: 4 }}>Columns</Text>
                    </TouchableOpacity>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <View style={{ position: 'relative', flex: 1 }}>
                        <Ionicons
                            name="search-outline"
                            size={16}
                            color={theme.foreground}
                            style={{ position: 'absolute', left: 12, top: 12, zIndex: 1 }}
                        />
                        <TextInput
                            placeholder="Search data..."
                            placeholderTextColor={isDark ? '#888' : '#666'}
                            value={searchTerm}
                            onChangeText={(text) => {
                                setSearchTerm(text);
                                setCurrentPage(1);
                            }}
                            style={{
                                backgroundColor: isDark ? '#333' : '#fff',
                                borderWidth: 1,
                                borderColor: isDark ? '#404040' : '#e9ecef',
                                borderRadius: 6,
                                paddingHorizontal: 12,
                                paddingVertical: 10,
                                paddingLeft: 36,
                                fontSize: 14,
                                color: theme.foreground
                            }}
                        />
                    </View>
                </View>

                <Text style={{ fontSize: 12, color: theme.foreground, opacity: 0.7 }}>
                    {processedData.length.toLocaleString()} rows, {visibleHeaders.length} columns
                    {searchTerm && ` (filtered from ${parsedData.data.length.toLocaleString()})`}
                </Text>

                {showColumnFilter && (
                    <View style={{
                        marginTop: 12,
                        padding: 12,
                        backgroundColor: isDark ? '#404040' : '#ffffff',
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: isDark ? '#505050' : '#e9ecef'
                    }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.foreground, marginBottom: 8 }}>
                            Show/Hide Columns
                        </Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {parsedData.headers.map(header => (
                                <TouchableOpacity
                                    key={header}
                                    onPress={() => toggleColumnVisibility(header)}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        paddingHorizontal: 8,
                                        paddingVertical: 4,
                                        backgroundColor: !hiddenColumns.has(header) ?
                                            (isDark ? '#555' : '#007AFF') :
                                            (isDark ? '#333' : '#f0f0f0'),
                                        borderRadius: 4
                                    }}
                                >
                                    <Ionicons
                                        name={!hiddenColumns.has(header) ? 'checkmark' : 'close'}
                                        size={12}
                                        color={!hiddenColumns.has(header) ? 'white' : theme.foreground}
                                        style={{ marginRight: 4 }}
                                    />
                                    <Text style={{
                                        fontSize: 12,
                                        color: !hiddenColumns.has(header) ? 'white' : theme.foreground
                                    }}>
                                        {header}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}
            </View>

            {/* Table */}
            <FlatList
                data={tableData}
                renderItem={renderTableRow}
                keyExtractor={(item, index) => `${item.type}-${index}`}
                horizontal
                showsHorizontalScrollIndicator={true}
                style={{ flex: 1 }}
                contentContainerStyle={{ minWidth: visibleHeaders.length * 150 }}
            />

            {/* Pagination */}
            {totalPages > 1 && (
                <View style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: isDark ? '#2a2a2a' : '#f8f9fa',
                    borderTopWidth: 1,
                    borderTopColor: isDark ? '#404040' : '#e9ecef'
                }}>
                    <Text style={{ fontSize: 12, color: theme.foreground, opacity: 0.7 }}>
                        Showing {startIndex + 1} to {Math.min(startIndex + rowsPerPage, processedData.length)} of {processedData.length.toLocaleString()} rows
                    </Text>

                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <TouchableOpacity
                            onPress={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                            disabled={currentPage === 1}
                            style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                backgroundColor: currentPage === 1 ? 'transparent' : (isDark ? '#404040' : '#e9ecef'),
                                borderRadius: 4,
                                marginRight: 8
                            }}
                        >
                            <Text style={{
                                fontSize: 12,
                                color: currentPage === 1 ? (isDark ? '#555' : '#ccc') : theme.foreground
                            }}>
                                Previous
                            </Text>
                        </TouchableOpacity>

                        {/* Page numbers */}
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                            let pageNum;
                            if (totalPages <= 5) {
                                pageNum = i + 1;
                            } else if (currentPage <= 3) {
                                pageNum = i + 1;
                            } else if (currentPage >= totalPages - 2) {
                                pageNum = totalPages - 4 + i;
                            } else {
                                pageNum = currentPage - 2 + i;
                            }

                            return (
                                <TouchableOpacity
                                    key={pageNum}
                                    onPress={() => setCurrentPage(pageNum)}
                                    style={{
                                        paddingHorizontal: 8,
                                        paddingVertical: 4,
                                        backgroundColor: currentPage === pageNum ? '#007AFF' : (isDark ? '#404040' : '#e9ecef'),
                                        borderRadius: 4,
                                        marginHorizontal: 2,
                                        minWidth: 32,
                                        alignItems: 'center'
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 12,
                                        color: currentPage === pageNum ? 'white' : theme.foreground
                                    }}>
                                        {pageNum}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}

                        <TouchableOpacity
                            onPress={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                            disabled={currentPage === totalPages}
                            style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                backgroundColor: currentPage === totalPages ? 'transparent' : (isDark ? '#404040' : '#e9ecef'),
                                borderRadius: 4,
                                marginLeft: 8
                            }}
                        >
                            <Text style={{
                                fontSize: 12,
                                color: currentPage === totalPages ? (isDark ? '#555' : '#ccc') : theme.foreground
                            }}>
                                Next
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}
        </View>
    );
} 