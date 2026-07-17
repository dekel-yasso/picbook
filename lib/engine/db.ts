import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BookDoc, Decision, DecisionRecord, PhotoMeta, Trip } from './types';

interface PicBookDB extends DBSchema {
  photos: { key: string; value: PhotoMeta };
  /** Blob from native ingest; ArrayBuffer when written by backup import (iOS-safe). */
  thumbs: { key: string; value: Blob | ArrayBuffer };
  decisions: { key: string; value: Decision | DecisionRecord };
  /** Print-quality (2048px JPEG) copies of keepers — survive across sessions. */
  renditions: { key: string; value: Blob };
  books: { key: string; value: BookDoc };
  /** Reverse-geocode cache: "lat,lon" (2dp) → place name ('' = looked up, nothing found). */
  geo: { key: string; value: string };
  trips: { key: string; value: Trip };
  /** Small user media, e.g. the custom clip soundtrack.
   *  `credit` marks CC-licensed downloads that need an attribution card. */
  media: { key: string; value: { blob: Blob; name: string; credit?: string } };
}

let dbPromise: Promise<IDBPDatabase<PicBookDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<PicBookDB>> {
  if (!dbPromise) {
    let instance: IDBPDatabase<PicBookDB> | null = null;
    dbPromise = openDB<PicBookDB>('picbook', 6, {
      // Another PicBook context (e.g. the home-screen app vs the Safari tab)
      // needs a newer schema: close our connection so it isn't blocked forever.
      // The next getDB() call here reconnects at the new version.
      blocking() {
        instance?.close();
        instance = null;
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('photos');
          db.createObjectStore('thumbs');
        }
        if (oldVersion < 2) {
          db.createObjectStore('decisions');
        }
        if (oldVersion < 3) {
          db.createObjectStore('renditions');
          db.createObjectStore('books');
        }
        if (oldVersion < 4) {
          db.createObjectStore('geo');
        }
        if (oldVersion < 5) {
          db.createObjectStore('trips');
        }
        if (oldVersion < 6) {
          db.createObjectStore('media');
        }
      },
    }).then((db) => {
      instance = db;
      return db;
    });
  }
  return dbPromise;
}
