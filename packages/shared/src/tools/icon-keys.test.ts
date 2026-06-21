import { describe, test, expect } from 'bun:test';
import { getToolIconKey } from './icon-keys';

describe('getToolIconKey', () => {
  test('returns wrench for undefined input', () => {
    expect(getToolIconKey(undefined)).toBe('wrench');
  });

  test('returns wrench for an empty string', () => {
    expect(getToolIconKey('')).toBe('wrench');
  });

  test('returns hammer for initialization tools', () => {
    expect(getToolIconKey('initialize-tools')).toBe('hammer');
    expect(getToolIconKey('initialize_tools')).toBe('hammer');
  });

  test('returns globe for browser and web tools', () => {
    expect(getToolIconKey('browser-navigate-to')).toBe('globe');
    expect(getToolIconKey('scrape-webpage')).toBe('globe');
    expect(getToolIconKey('web-search')).toBe('globe');
  });

  test('returns image for image search', () => {
    expect(getToolIconKey('image-search')).toBe('image');
    expect(getToolIconKey('image_search')).toBe('image');
  });

  test('returns file-edit for create and edit file tools', () => {
    expect(getToolIconKey('create-file')).toBe('file-edit');
    expect(getToolIconKey('edit-file')).toBe('file-edit');
  });

  test('returns file-x for delete file tools', () => {
    expect(getToolIconKey('delete-file')).toBe('file-x');
  });

  test('returns terminal for command tools', () => {
    expect(getToolIconKey('execute-command')).toBe('terminal');
    expect(getToolIconKey('terminate-command')).toBe('terminal');
  });

  test('returns code for code execution tools', () => {
    expect(getToolIconKey('execute-code')).toBe('code');
  });

  test('returns phone for call tools and phone-off for ending a call', () => {
    expect(getToolIconKey('make-phone-call')).toBe('phone');
    expect(getToolIconKey('end-call')).toBe('phone-off');
  });

  test('returns check-circle for complete', () => {
    expect(getToolIconKey('complete')).toBe('check-circle');
  });

  test('is case-insensitive', () => {
    expect(getToolIconKey('EXECUTE-COMMAND')).toBe('terminal');
    expect(getToolIconKey('Web-Search')).toBe('globe');
  });

  test('returns wrench for unknown non-mcp tools', () => {
    expect(getToolIconKey('totally-unknown-tool')).toBe('wrench');
  });

  test('returns plug for generic mcp tools', () => {
    expect(getToolIconKey('mcp_customserver_dosomething')).toBe('plug');
  });

  test('returns search for mcp tools whose name mentions search', () => {
    expect(getToolIconKey('mcp_someserver_search_things')).toBe('search');
  });

  test('returns book-open for mcp tools whose name mentions a paper', () => {
    expect(getToolIconKey('mcp_someserver_paper_lookup')).toBe('book-open');
  });

  test('returns search for exa mcp tools without a matching name keyword', () => {
    expect(getToolIconKey('mcp_exa_fetch')).toBe('search');
  });

  test('treats short mcp prefixes without enough parts as plug', () => {
    expect(getToolIconKey('mcp_onlyone')).toBe('plug');
  });
});
