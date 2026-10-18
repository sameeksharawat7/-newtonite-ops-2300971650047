import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './styles.css';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: 1, refetchOnWindowFocus: true } },
});
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><App /></QueryClientProvider>,
);
