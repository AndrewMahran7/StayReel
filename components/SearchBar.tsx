// components/SearchBar.tsx

import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

interface Props {
  value:         string;
  onChangeText:  (t: string) => void;
  placeholder?:  string;
}

export function SearchBar({ value, onChangeText, placeholder = 'Search…' }: Props) {
  return (
    <View style={styles.wrap}>
      <Ionicons name="search" size={17} color={C.textMuted} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
      {value.length > 0 && (
        <TouchableOpacity onPress={() => onChangeText('')}>
          <Ionicons name="close-circle" size={17} color={C.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection:    'row',
    alignItems:       'center',
    backgroundColor:  C.surfaceAlt,
    borderRadius:     12,
    paddingHorizontal: 12,
    paddingVertical:   10,
    gap:              8,
    marginHorizontal: 16,
    marginBottom:     8,
  },
  input: {
    flex:     1,
    color:    C.textPrimary,
    fontSize: 15,
    padding:  0,
  },
});
