import { Redirect } from 'expo-router';
import { isOwner, useAuth } from '../src/auth/store';

/** Entry route: send each person to the right home screen. */
export default function Index() {
  const user = useAuth((s) => s.user);
  if (!user) return <Redirect href="/(auth)/login" />;
  return <Redirect href={isOwner(user) ? '/(owner)/dashboard' : '/(staff)/stock'} />;
}
