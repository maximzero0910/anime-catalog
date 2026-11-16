import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAndSortAnime, type FilterableAnime } from '../catalog-filters';

const anime: FilterableAnime[] = [
  { id: '1', anilistId: 1, title: 'Action Romance', genres: ['Action', 'Romance'], tags: [], animeType: 'TV', format: 'TV', year: 2020, season: 'SPRING', status: 'FINISHED', rating: 8.2, popularity: 40 },
  { id: '2', anilistId: 2, title: 'Isekai Movie', genres: ['Fantasy'], tags: ['Isekai'], animeType: 'MOVIE', format: 'MOVIE', year: 2023, season: 'WINTER', status: 'RELEASING', rating: 9.1, popularity: 90 },
  { id: '3', anilistId: 3, title: 'Drama Short', genres: ['Drama'], tags: [], animeType: 'TV_SHORT', format: 'TV_SHORT', year: 2018, season: 'FALL', status: 'FINISHED', rating: 7.3, popularity: 20 },
];

test('genre selections use OR while different filter categories combine with AND', () => {
  assert.deepEqual(filterAndSortAnime(anime, { genres: ['Action', 'Isekai'], status: 'FINISHED' }).map(item => item.id), ['1']);
  assert.deepEqual(filterAndSortAnime(anime, { genres: ['Action', 'Isekai'], types: ['MOVIE'] }).map(item => item.id), ['2']);
});

test('year ranges, recent status, season, and coarse formats filter results', () => {
  assert.deepEqual(filterAndSortAnime(anime, { year: 2020 }).map(item => item.id), ['1']);
  assert.deepEqual(filterAndSortAnime(anime, { yearFrom: 2019, yearTo: 2023, season: 'WINTER' }).map(item => item.id), ['2']);
  assert.deepEqual(filterAndSortAnime(anime, { format: 'SHORT' }).map(item => item.id), ['3']);
  assert.deepEqual(filterAndSortAnime(anime, { status: 'FINISHED', season: 'SPRING' }).map(item => item.id), ['1']);
  assert.deepEqual(filterAndSortAnime(anime, { recent: true }).map(item => item.id), ['2']);
});

test('minimum rating and each sorting mode are applied independently', () => {
  assert.deepEqual(filterAndSortAnime(anime, { minRating: 8.5, sort: 'rating' }).map(item => item.id), ['2']);
  assert.deepEqual(filterAndSortAnime(anime, { sort: 'rating' }).map(item => item.id), ['2', '1', '3']);
  assert.deepEqual(filterAndSortAnime(anime, { sort: 'recent' }).map(item => item.id), ['2', '1', '3']);
  assert.deepEqual(filterAndSortAnime(anime, { sort: 'alphabetical' }).map(item => item.id), ['1', '3', '2']);
  assert.deepEqual(filterAndSortAnime(anime, { sort: 'added' }).map(item => item.id), ['3', '2', '1']);
  assert.deepEqual(filterAndSortAnime(anime, {}).map(item => item.id), ['2', '1', '3']);
});
