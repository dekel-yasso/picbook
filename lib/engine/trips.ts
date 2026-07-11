import { getDB } from './db';
import type { Trip } from './types';

/** Photos imported before trips existed (tripId absent) belong here. */
export const DEFAULT_TRIP_ID = 'default';

/** All trips, oldest first; ensures the default trip exists. */
export async function loadTrips(): Promise<Trip[]> {
  const db = await getDB();
  let trips = await db.getAll('trips');
  if (!trips.some((t) => t.id === DEFAULT_TRIP_ID)) {
    const def: Trip = { id: DEFAULT_TRIP_ID, name: 'My photos', createdAt: Date.now(), updatedAt: Date.now() };
    await db.put('trips', def, def.id);
    trips = [def, ...trips];
  }
  return trips.sort((a, b) => a.createdAt - b.createdAt);
}

export async function createTrip(name: string): Promise<Trip> {
  const trip: Trip = {
    id: crypto.randomUUID(),
    name: name.trim() || 'New trip',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const db = await getDB();
  await db.put('trips', trip, trip.id);
  return trip;
}

export async function renameTrip(id: string, name: string): Promise<void> {
  const db = await getDB();
  const trip = await db.get('trips', id);
  if (trip) {
    await db.put('trips', { ...trip, name: name.trim() || trip.name, updatedAt: Date.now() }, id);
  }
}
